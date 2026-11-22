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
  let baseline = { happy: 15, sad: 5, fear: 5, anger: 0, surprise: 0, disgust: 5 };

  // Ref for tools to access current baseline
  const baselineRef = { current: baseline };

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
    baseline = await store.loadBaseline();
    baselineRef.current = { ...baseline };
    // Ensure queue exists
    if (!state.queue) state.queue = [];
  }

  // --- Tick ---
  async function tick(now) {
    if (!state) return;

    const dtMs = now - (state.lastTickAt || now);
    if (dtMs < 60000) return; // Minimum 1 minute between ticks

    // 1. Decay
    state.values = MoodPool.decay(state.values, baseline, dtMs);

    // 2. Apply event queue
    const queue = store.drainQueue(state);
    for (const entry of queue) {
      const deltas = entry.deltas || [];
      for (const d of deltas) {
        // Apply state modifiers to the delta
        const mods = States.compositeMod(state.states);
        let factor = 1;
        if (d.base && mods[d.base]) factor = mods[d.base];
        const adjustedDelta = d.delta * factor;

        MoodPool.apply(state.values, d.base, adjustedDelta, d.cap || 25);
      }
    }

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
        delta: missingResult.delta,
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
      // Inject into all active agents
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

  // --- Judge a message and enqueue deltas ---
  async function handleMessage(agent, message) {
    if (!state) return;

    // Only process user messages
    if (message.role !== 'user') return;

    // Skip steer messages injected by ourselves (they start with 【情绪】)
    const text = typeof message.content === 'string' ? message.content : '';
    if (!text.trim() || text.startsWith('【情绪】')) return;

    const now = Date.now();

    // Judge (with context if it's ambiguous later)
    const result = await judge.judge(text, null);

    // Boredom drop: any message → ×0.7
    const boredomDrop = Boredom.drop(state.boredom, now, 'msg');
    if (boredomDrop > 0) {
      fireAndForget(log.append({
        ts: now, block: '无聊', emotion: '无聊',
        delta: -Math.round(boredomDrop * 10) / 10,
        reason: '有人说话了 ×0.7'
      }));
    }

    // Check if this is likely from the owner (DSH input box, not external bridge)
    const msgSource = message.source || {};
    const isOwner = !msgSource.kind || msgSource.kind === 'user' || msgSource.kind === 'composer';

    // Missing drop: only owner
    if (isOwner) {
      Missing.drop(state.missing, now);
    }

    if (!result.emotions || result.emotions.length === 0) return;

    const about = result.about || 'unknown';
    let needsImmediateSettlement = false;
    const immediateDeltas = [];

    for (const hisEmotion of result.emotions) {
      // Convert to her emotion
      const herResult = await empathy.convert(hisEmotion, about);
      if (!herResult) continue;

      const herWeights = await empathy.weightsFor(herResult.key);
      const herCap = await empathy.capFor(herResult.key);
      const score = herResult.intensity * herCap;

      if (score < 0.15 * herCap) continue;

      // Calculate deltas (without modifying pool)
      const deltas = MoodPool.calculateWeighted(herWeights, score, herCap);
      if (deltas.length === 0) continue;

      // Log
      const herLabel = await empathy.labelFor(herResult.key);
      for (const d of deltas) {
        const blockName = MoodLog.blockForBase(d.base);
        fireAndForget(log.append({
          ts: now, block: blockName, emotion: `${herLabel} ${herResult.key}`,
          delta: d.delta,
          reason: (hisEmotion.evidence || text).slice(0, 70),
          stateNote: States.formatActive(state.states) || '—'
        }));
      }

      // Coupling: event propagation
      for (const d of deltas) {
        const propagated = Coupling.propagate(state.values, d.base, d.delta);
        for (const p of propagated) {
          const pBlock = MoodLog.blockForBase(p.base);
          fireAndForget(log.append({
            ts: now, block: pBlock, emotion: '传播',
            delta: p.delta,
            reason: `由 ${MoodLog.blockForBase(p.parent)} 传播`,
            stateNote: '—'
          }));
        }
      }

      // State trigger
      const stateDef = await empathy.stateFor(herResult.key);
      if (stateDef) {
        if (stateDef.when === 'fromUser' && !isOwner) continue;
        States.activate(state.states, stateDef, now, herResult.key);
        fireAndForget(log.append({
          ts: now, block: '状态', emotion: stateDef.name,
          delta: 0,
          reason: `触发：${herLabel}`,
          stateNote: `${stateDef.minutes || 60}min`
        }));
      }

      // Immediate settlement for strong hits (>20)
      if (score > 20) {
        needsImmediateSettlement = true;
        for (const d of deltas) {
          immediateDeltas.push(d);
        }
        // Don't enqueue these — they're applied now
      } else {
        // Enqueue for next tick
        store.enqueue(state, { deltas, ts: now });
      }
    }

    // Apply immediate settlement (no decay, no tick reset)
    if (needsImmediateSettlement) {
      MoodPool.applyDeltas(state.values, immediateDeltas);
      MoodPool.clamp(state.values);
    }

    // Throttled save: write at most once per 3 minutes
    stateDirty = true;
    saveStateIfDirty(now).catch(() => {});
  }

  // --- Agent lifecycle ---
  ctx.on('agent/created', (payload) => {
    const { agent } = payload;
    const agentCtx = agent.ctx;
    if (!agentCtx) return;

    // Create status bar for this agent
    const sb = new StatusBar(agent);
    statusBars.set(agent.id, sb);

    // Listen for inbox messages on this agent
    agentCtx.on('agent/inbox/inserted', (p) => {
      handleMessage(p.agent, p.message).catch(err => {
        ctx.logger?.warn?.('[dsh-mood] handleMessage error:', err);
      });
    });

    // Cleanup on dispose
    ctx.on('agent/disposed', (p) => {
      if (p.agent.id === agent.id) {
        statusBars.delete(agent.id);
      }
    });
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