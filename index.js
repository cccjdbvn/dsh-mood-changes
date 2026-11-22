import { MoodStore } from './lib/store.js';
import { MoodPool } from './lib/pool.js';
import { Judge } from './lib/judge.js';
import { Empathy } from './lib/empathy.js';
import { MoodLog } from './lib/log.js';
import { Coupling } from './lib/coupling.js';
import { Missing } from './lib/missing.js';
import { Boredom } from './lib/boredom.js';
import { States } from './lib/states.js';
import { StatusBar } from './lib/statusbar.js';
import { registerRoutes } from './lib/routes.js';
import { registerTools } from './lib/tools.js';

export const Config = {
  schema: {
    type: 'object',
    properties: {
      judgeBaseUrl: { type: 'string', description: '本地 LLM 端点', default: 'http://127.0.0.1:1234/v1' },
      judgeApiKey: { type: 'string', description: 'API Key（可选）', default: '' },
      judgeModel: { type: 'string', description: '模型名', default: 'local-model' },
      judgeTimeout: { type: 'number', description: '请求超时（毫秒）', default: 3000 },
      judgeTemperature: { type: 'number', description: '采样温度', default: 0.3 },
      tickIntervalMs: { type: 'number', description: 'tick 间隔（毫秒）', default: 900000 },
      worldDir: { type: 'string', description: '世界目录路径（存放 state 和日志）', default: '' }
    }
  }
};

export function apply(ctx, config) {
  const worldDir = config.worldDir;
  if (!worldDir) {
    ctx.logger?.warn?.('[dsh-mood] worldDir not configured; plugin inactive');
    return;
  }

  const store = new MoodStore(worldDir);
  const judge = new Judge(config);
  const empathy = new Empathy();
  const log = new MoodLog(worldDir);

  // Mutable state (loaded from disk on start)
  let state = null;

  // Single source of truth for the baseline: the mood_baseline tool writes
  // into this ref, and tick() reads from it (KNOWN-ISSUES A3 — previously
  // tick used a stale closure copy and tool edits never took effect).
  const baselineRef = { current: { happy: 15, sad: 5, fear: 5, anger: 0, surprise: 0, disgust: 5 } };

  // Per-agent status bar instances
  const statusBars = new Map();

  // State write-back throttle: at most once every 3 minutes from handleMessage
  const STATE_SAVE_INTERVAL = 180000; // 3 min
  let lastStateSaveAt = 0;
  let stateDirty = false;

  function fireAndForget(promise) {
    promise.catch(() => {});
  }

  async function saveStateIfDirty(now) {
    if (stateDirty && (now - lastStateSaveAt) >= STATE_SAVE_INTERVAL) {
      stateDirty = false;
      lastStateSaveAt = now;
      await store.saveState(state);
    }
  }

  // --- Initialization ---
  async function init() {
    state = await store.loadState();
    baselineRef.current = await store.loadBaseline();
    // Ensure queue exists
    if (!state.queue) state.queue = [];
  }

  /**
   * Settlement: apply queued deltas to the pool, then run event propagation
   * for exactly these entries (KNOWN-ISSUES A6 — propagation now happens at
   * settlement time, together with the main entries, and is also multiplied
   * by the active state modifiers per A5). Shared by tick() and by the
   * immediate settlement path. Does NOT decay and does NOT touch lastTickAt.
   */
  function settleEntries(entries, now) {
    if (!entries || entries.length === 0) return;
    const mods = States.compositeMod(state.states);
    const propLog = [];

    for (const entry of entries) {
      for (const d of entry.deltas || []) {
        MoodPool.apply(state.values, d.base, d.delta, d.cap);
      }
      for (const d of entry.deltas || []) {
        const propagated = Coupling.propagate(state.values, d.base, d.delta, mods);
        for (const p of propagated) {
          propLog.push({
            ts: now, block: MoodLog.blockForBase(p.base),
            emotion: '传播',
            delta: p.delta,
            reason: `由 ${MoodLog.blockForBase(p.parent)} 传播`,
            stateNote: '—'
          });
        }
      }
    }

    MoodPool.clamp(state.values);
    if (propLog.length) fireAndForget(log.appendBatch(propLog));
  }

  // --- Tick ---
  async function tick(now) {
    if (!state) return;

    const dtMs = now - (state.lastTickAt || now);
    if (dtMs < 60000) return; // Minimum 1 minute between ticks

    // 1. Decay toward the CURRENT baseline (A3)
    state.values = MoodPool.decay(state.values, baselineRef.current, dtMs);

    // 2. Settle the event queue (apply + propagate; modifiers were applied
    //    at judge time on the queued deltas, so no re-multiplication here)
    settleEntries(store.drainQueue(state), now);

    // 3. Coupling: tick damping
    Coupling.dampen(state.values, 0); // Start at 0, increase after a week

    // 4. Missing & Boredom tick
    const missingGain = States.missingGainMultiplier(state.states);
    const missingStep = States.missingStepBonus(state.states);
    const missingResult = Missing.tick(state.missing, now, missingGain, missingStep);

    const boredomStep = States.boredomStepBonus(state.states);
    Boredom.tick(state.boredom, now, boredomStep);

    // Log missing cross-threshold
    if (missingResult.crossedThreshold) {
      fireAndForget(log.append({
        ts: now, block: '思念', emotion: '思念',
        delta: Math.round(missingResult.delta * 10) / 10,
        reason: `跨档：→ ${missingResult.thresholdLabel}`,
        stateNote: States.formatActive(state.states) || '—'
      }));
    }

    // 5. Clamp
    MoodPool.clamp(state.values);

    // 6. Expire states
    States.expire(state.states, now);

    // 7. Save (flush any dirty state from handleMessage as well)
    stateDirty = false;
    lastStateSaveAt = now;
    state.lastTickAt = now;
    await store.saveState(state);

    // 8. Maybe inject status
    if (StatusBar.shouldInject(state, now)) {
      state.lastInjectAt = now;
      const agents = ctx.get('agents');
      if (agents) {
        for (const agent of agents.list()) {
          try {
            const sb = statusBars.get(agent.id);
            if (sb) sb.inject(state);
          } catch (e) { /* agent may not be ready */ }
        }
      }
    }
  }

  // --- Judge a message, enqueue deltas, settle on strong triggers ---
  async function handleMessage(agent, message) {
    if (!state) return;

    // Only process user messages
    if (message.role !== 'user') return;

    // Skip steer messages injected by ourselves (they start with 【情绪】)
    // NOTE (KNOWN-ISSUES B2): prefix matching is fragile; switch to a source
    // marker once the injected message shape is verified at runtime.
    const text = typeof message.content === 'string' ? message.content : '';
    if (!text.trim() || text.startsWith('【情绪】')) return;

    const now = Date.now();

    // Judge (with context if it's ambiguous later)
    const result = await judge.judge(text, null);

    const logBatch = [];

    // Boredom drop: any message → ×0.7
    const boredomDrop = Boredom.drop(state.boredom, now, 'msg');
    if (boredomDrop > 0) {
      logBatch.push({
        ts: now, block: '无聊', emotion: '无聊',
        delta: -Math.round(boredomDrop * 10) / 10,
        reason: '有人说话了 ×0.7'
      });
    }

    // Check if this is likely from the owner (DSH input box, not external bridge)
    const msgSource = message.source || {};
    const isOwner = !msgSource.kind || msgSource.kind === 'user' || msgSource.kind === 'composer';

    // Missing drop: only owner
    if (isOwner) {
      Missing.drop(state.missing, now);
    }

    if (result.emotions && result.emotions.length > 0) {
      const about = result.about || 'unknown';
      let strongTrigger = false;
      const newEntries = [];

      for (const hisEmotion of result.emotions) {
        // Convert to her emotion
        const herResult = await empathy.convert(hisEmotion, about);
        if (!herResult) continue;

        const herWeights = await empathy.weightsFor(herResult.key);
        const herCap = await empathy.capFor(herResult.key);
        const score = herResult.intensity * herCap;

        if (score < 0.15 * herCap) continue;

        // Calculate raw deltas (without modifying pool)
        const deltas = MoodPool.calculateWeighted(herWeights, score, herCap);
        if (deltas.length === 0) continue;

        // A5: multiply by the composite state modifiers AT JUDGE TIME.
        // The log records the effective value, with the raw value in
        // parentheses when a modifier applied.
        const mods = States.compositeMod(state.states);
        const activeStateNote = States.formatActive(state.states);
        const herLabel = await empathy.labelFor(herResult.key);
        const adjusted = deltas.map(d => {
          const factor = mods[d.base] ?? 1;
          return {
            base: d.base,
            delta: Math.round(d.delta * factor * 10) / 10,
            cap: herCap, // A4: carry the per-emotion cap into the queue
            origDelta: factor !== 1 ? d.delta : undefined
          };
        });

        // Main-entry log rows: effective value (+ original when modified)
        for (const a of adjusted) {
          logBatch.push({
            ts: now, block: MoodLog.blockForBase(a.base),
            emotion: `${herLabel} ${herResult.key}`,
            delta: a.delta,
            origDelta: a.origDelta,
            reason: (hisEmotion.evidence || text).slice(0, 70),
            stateNote: a.origDelta !== undefined
              ? `${activeStateNote} ×${(mods[a.base]).toFixed(1)}`
              : '—'
          });
        }

        // State trigger. Activation happens AFTER this entry's deltas were
        // computed, so the newly activated state affects later entries only.
        const stateDef = await empathy.stateFor(herResult.key);
        if (stateDef) {
          if (stateDef.when === 'fromUser' && !isOwner) continue;
          States.activate(state.states, stateDef, now, herResult.key);
          logBatch.push({
            ts: now, block: '状态', emotion: stateDef.name,
            delta: 0,
            reason: `触发：${herLabel}`,
            stateNote: `${stateDef.minutes || 60}min`
          });
          strongTrigger = true;
        }

        // Strong single hit → immediate settlement
        if (score > 20) strongTrigger = true;

        newEntries.push({ deltas: adjusted, ts: now });
      }

      if (newEntries.length > 0) {
        if (strongTrigger) {
          // Immediate settlement (SPEC 5.3): settle the WHOLE queue plus this
          // message's entries — no decay, no lastTickAt reset.
          settleEntries([...store.drainQueue(state), ...newEntries], now);
        } else {
          for (const e of newEntries) store.enqueue(state, e);
        }
      }
    }

    if (logBatch.length > 0) fireAndForget(log.appendBatch(logBatch));

    // Throttled save: write at most once per 3 minutes
    stateDirty = true;
    saveStateIfDirty(now).catch(() => {});
  }

  // --- Agent lifecycle ---
  ctx.on('agent/created', (payload) => {
    const { agent } = payload;
    const agentCtx = agent.ctx;
    if (!agentCtx) return;

    statusBars.set(agent.id, new StatusBar(agent));

    // Per-agent inbox listener lives on the agent's own context, so it is
    // removed when the agent is disposed.
    agentCtx.on('agent/inbox/inserted', (p) => {
      handleMessage(p.agent, p.message).catch(err => {
        ctx.logger?.warn?.('[dsh-mood] handleMessage error:', err);
      });
    });
  });

  // C2: one shared disposal listener instead of one per agent (the old
  // pattern leaked a listener for every agent ever created).
  ctx.on('agent/disposed', (p) => {
    statusBars.delete(p.agent.id);
  });

  // --- Tick timer ---
  const tickInterval = ctx.interval(async () => {
    try {
      await tick(Date.now());
    } catch (e) {
      ctx.logger?.warn?.('[dsh-mood] tick error:', e);
    }
  }, config.tickIntervalMs || 900000);

  // --- Register tools ---
  let toolDisposers = [];
  try {
    toolDisposers = registerTools(ctx, store, baselineRef, () => state);
  } catch (e) {
    ctx.logger?.warn?.('[dsh-mood] tool registration error:', e);
  }

  // --- Register HTTP routes ---
  try {
    registerRoutes(ctx, store, () => state);
  } catch (e) {
    ctx.logger?.warn?.('[dsh-mood] route registration error:', e);
  }

  // --- Tools/result → boredom drop ---
  ctx.on('tools/result', (exec) => {
    if (!state) return;
    const now = Date.now();
    const drop = Boredom.drop(state.boredom, now, 'tool');
    if (drop > 0) {
      fireAndForget(log.append({
        ts: now, block: '无聊', emotion: '无聊',
        delta: -Math.round(drop * 10) / 10,
        reason: `做了件事（${exec.name}）×0.5`
      }));
      stateDirty = true;
      saveStateIfDirty(now).catch(() => {});
    }
  });

  // --- Init ---
  init().then(() => {
    ctx.logger?.info?.('[dsh-mood] Initialized with worldDir:', worldDir);
  }).catch(e => {
    ctx.logger?.warn?.('[dsh-mood] init error:', e);
  });

  // --- Cleanup ---
  return () => {
    tickInterval();
    for (const d of toolDisposers) d();
    // Force final save if dirty
    if (stateDirty && state) {
      store.saveState(state).catch(() => {});
    }
  };
}