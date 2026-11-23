import Schema from '@deepseek-ai/schemastery';
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

export const Config = Schema.object({
  worldDir: Schema.string().default('').description('世界目录路径（存放 state 和日志）；留空 = 插件不启动'),
  judgeBaseUrl: Schema.string().default('http://127.0.0.1:8000/v1').description('本地 LLM 端点（OpenAI 兼容，vLLM/LM Studio）'),
  judgeApiKey: Schema.string().default('').description('API Key（可选，多数本地端点不需要）'),
  judgeModel: Schema.string().default('').description('模型名（vLLM 部署时填模型路径或 served-model-name）'),
  judgeTimeout: Schema.number().default(3000).description('判句请求超时（毫秒）'),
  judgeTemperature: Schema.number().default(0.3).description('判官采样温度'),
  tickIntervalMs: Schema.number().default(900000).description('tick 间隔（毫秒，默认 15 分钟）'),
  ownerNames: Schema.array(Schema.string()).default([]).description('主人在 QQ 消息里的显示名；群聊一律不降思念，私聊且名字在列表里才降'),
});

/** Extract plain text from a message whose content may be a string or blocks. */
function textOf(message) {
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
  return '';
}

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
  const ownerNames = config.ownerNames || [];

  // Mutable state (loaded from disk on start)
  let state = null;

  // Single source of truth for the baseline: the mood_baseline tool writes
  // into this ref, and tick() reads from it (KNOWN-ISSUES A3).
  const baselineRef = { current: { happy: 15, sad: 5, fear: 5, anger: 0, surprise: 0, disgust: 5 } };

  // Per-agent status bar instances
  const statusBars = new Map();

  // State write-back throttle: at most once every 3 minutes from handleMessage
  const STATE_SAVE_INTERVAL = 180000; // 3 min
  let lastStateSaveAt = 0;
  let stateDirty = false;

  // Message ring buffer: context source for the judge's second round.
  const CONTEXT_WINDOW_MS = 20 * 60000; // 20 minutes
  const CONTEXT_MAX = 10; // up to 10 recent messages, never reaching further back
  const msgBuffer = [];

  // Summary bookkeeping ("搭车"): reset on every injection (status bar or
  // knock), rendered only when a knock fires.
  let summary = null;

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
    if (!state.queue) state.queue = [];
    // Backfill newer fields on old state files.
    if (!state.missing) state.missing = { value: 0, lastDropAt: 0, lastNotifyAt: 0, lastRoll: 0, lastHitAt: 0, manualDay: '', manualSum: 0 };
    if (!state.missing.lastNotifyAt) state.missing.lastNotifyAt = 0;
    if (!state.missing.lastRoll) state.missing.lastRoll = 0;
    if (!state.boredom) state.boredom = { value: 0, lastMsgAt: 0, lastToolAt: 0 };
    if (!state.boredom.lastNotifyAt) state.boredom.lastNotifyAt = 0;
    if (!state.boredom.lastRoll) state.boredom.lastRoll = 0;
    resetSummary(Date.now());
  }

  function resetSummary(now) {
    summary = {
      since: now,
      count: 0,        // main entries only (no propagation, no damping)
      big: [],         // single entries with |delta| > 20
      snapshot: state ? { ...state.values } : null
    };
  }

  function buildSummary(now) {
    if (!summary || summary.count === 0) return '';
    const fmt = t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const lines = [];
    lines.push(`（${fmt(summary.since)}–${fmt(now)}，共 ${summary.count} 笔）`);
    if (summary.snapshot && state) {
      const nets = [];
      for (const base of ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust']) {
        const d = (state.values[base] ?? 0) - (summary.snapshot[base] ?? 0);
        if (Math.abs(d) >= 0.05) nets.push(`${MoodLog.blockForBase(base)} ${d >= 0 ? '+' : ''}${d.toFixed(1)}`);
      }
      if (nets.length) lines.push(`六情本段：${nets.join(' / ')}`);
    }
    for (const b of summary.big.slice(0, 3)) {
      lines.push(`单笔较大：${b.label} ${b.delta >= 0 ? '+' : ''}${b.delta}（${b.reason}）`);
    }
    return '\n' + lines.join('\n');
  }

  /** Recent context for the judge's second round: last 10 messages within
   * 20 minutes, oldest first, excluding the message being judged. */
  function recentContext(now) {
    const ctx = [];
    for (let i = msgBuffer.length - 1; i >= 0 && ctx.length < CONTEXT_MAX; i--) {
      const m = msgBuffer[i];
      if (now - m.ts > CONTEXT_WINDOW_MS) break;
      ctx.unshift(m.text);
    }
    return ctx;
  }

  function pushBuffer(text, ts) {
    msgBuffer.push({ text, ts });
    if (msgBuffer.length > 60) msgBuffer.shift();
  }

  /**
   * Settlement: apply queued deltas to the pool, run event propagation, and
   * write the MAIN log rows here — at settlement time (A7): one log row per
   * real deposit, with 时间 = record time (judge) and 生效 = settlement time
   * (decay start). The log never claims a delta that never landed.
   * Does NOT decay and does NOT touch lastTickAt.
   */
  function settleEntries(entries, now) {
    if (!entries || entries.length === 0) return;
    const mods = States.compositeMod(state.states);
    const logBatch = [];

    for (const entry of entries) {
      const deltas = entry.deltas || [];
      for (const d of deltas) {
        const before = state.values[d.base] ?? 0;
        MoodPool.apply(state.values, d.base, d.delta, d.cap);
        const actual = Math.round(((state.values[d.base] ?? 0) - before) * 10) / 10;
        // Main row: record time = entry.ts, effective = now, change = actual.
        logBatch.push({
          ts: entry.ts,
          effectiveAt: now,
          block: MoodLog.blockForBase(d.base),
          emotion: entry.label || '',
          delta: actual,
          origDelta: d.origDelta,
          reason: entry.reason || '',
          stateNote: d.stateNote || '—'
        });
        // Summary bookkeeping rides with real deposits (main entries only).
        summary.count += 1;
        if (Math.abs(actual) > 20) {
          summary.big.push({
            label: entry.label || '',
            delta: actual,
            reason: (entry.reason || '').slice(0, 10)
          });
        }
      }
      for (const d of deltas) {
        const propagated = Coupling.propagate(state.values, d.base, d.delta, mods);
        for (const p of propagated) {
          logBatch.push({
            ts: now, effectiveAt: now,
            block: MoodLog.blockForBase(p.base),
            emotion: '传播',
            delta: p.delta,
            reason: `由 ${MoodLog.blockForBase(p.parent)} 传播`,
            stateNote: '—'
          });
        }
      }
    }

    MoodPool.clamp(state.values);
    if (logBatch.length) fireAndForget(log.appendBatch(logBatch));
  }

  // --- Knock (掷骰敲门): missing / boredom ask to interact ---

  /** Inject a knock message (with the riding summary) into all live agents. */
  function knock(text, now) {
    const full = text + buildSummary(now);
    const agents = ctx.get('agents');
    if (agents) {
      for (const agent of agents.list()) {
        const sb = statusBars.get(agent.id);
        if (sb) sb.knock(full);
      }
    }
    resetSummary(now);
    state.lastInjectAt = now; // a knock also opens a new summary segment
  }

  function tryKnock(now) {
    // 「有气无力」 skips dice rolls entirely (SPEC 5.5).
    if (States.hasSkipRoll(state.states)) return;

    const m = state.missing;
    if (!(m.lastNotifyAt && now - m.lastNotifyAt < 60 * 60000) && Missing.shouldKnock(m, now)) {
      m.lastNotifyAt = now;
      const v = (m.value || 0).toFixed(1);
      knock(m.value >= 80
        ? `思念 ${v}，好些时候没和主人说话了。`
        : `思念 ${v}，要不要和主人说句话？`, now);
    }

    const b = state.boredom;
    if (!(b.lastNotifyAt && now - b.lastNotifyAt < 60 * 60000) && Boredom.shouldKnock(b, now)) {
      b.lastNotifyAt = now;
      knock(`无聊 ${(b.value || 0).toFixed(1)}，要不要自己做点什么？`, now);
    }
  }

  // --- Tick ---
  async function tick(now) {
    if (!state) return;

    // B3: freeze while offline — elapsed time is capped at one tick, so a
    // restart after hours away decays exactly one step, not the whole gap.
    const dtMs = Math.min(now - (state.lastTickAt || now), config.tickIntervalMs || 900000);
    if (dtMs < 60000) return; // Minimum 1 minute between ticks

    // 1. Decay toward the CURRENT baseline (A3)
    state.values = MoodPool.decay(state.values, baselineRef.current, dtMs);

    // 2. Settle the event queue (apply + propagate)
    settleEntries(store.drainQueue(state), now);

    // 3. Coupling: tick damping
    Coupling.dampen(state.values, 0); // Start at 0, increase after a week

    // 4. Missing & Boredom tick
    const missingGain = States.missingGainMultiplier(state.states);
    const missingStep = States.missingStepBonus(state.states);
    const missingResult = Missing.tick(state.missing, now, missingGain, missingStep);

    const boredomStep = States.boredomStepBonus(state.states);
    Boredom.tick(state.boredom, now, boredomStep);

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

    // 8. Knock dice (missing / boredom)
    tryKnock(now);

    // 9. Maybe inject status bar
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
      resetSummary(now); // a status-bar injection opens a new summary segment
    }
  }

  // --- Judge a message, enqueue deltas, settle on strong triggers ---
  async function handleMessage(agent, message) {
    if (!state) return;

    // Only process user messages
    if (message.role !== 'user') return;

    const msgSource = message.source || {};
    const kind = msgSource.kind || '';

    // B2: skip our own injections (status bars and knocks) by source marker.
    if (kind === 'plugin:dsh-mood') return;

    const text = textOf(message);
    if (!text.trim()) return;

    const now = Date.now();

    // Judge: first round on the sentence alone; second round with recent
    // context when the first is not confident (B4/判官两级).
    const context = recentContext(now);
    const result = await judge.judge(text, context);
    pushBuffer(text, now);

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

    // B1: who counts as the owner?
    //  - DSH composer (no plugin kind) → owner
    //  - QQ bridge private chat + name in ownerNames → owner
    //  - group chat or anyone else → not the owner (missing never drops)
    let isOwner = false;
    if (!kind || kind === 'user') {
      isOwner = true;
    } else if (kind.startsWith('plugin:')) {
      const m = text.match(/^\[QQ[^\]]*\]\s*([^：:]{1,40})[：:]/);
      if (m) {
        const who = m[1].trim();
        const isPrivate = text.startsWith('[QQ · 私聊]');
        isOwner = isPrivate && ownerNames.includes(who);
      }
    }

    // Missing drop: only owner
    if (isOwner) {
      Missing.drop(state.missing, now);
    }

    if (result.emotions && result.emotions.length > 0) {
      const about = result.about || 'unknown';
      let strongTrigger = false;
      const newEntries = [];

      for (const hisEmotion of result.emotions) {
        const herResult = await empathy.convert(hisEmotion, about);
        if (!herResult) continue;

        const herWeights = await empathy.weightsFor(herResult.key);
        const herCap = await empathy.capFor(herResult.key);
        const score = herResult.intensity * herCap;

        if (score < 0.15 * herCap) continue;

        const deltas = MoodPool.calculateWeighted(herWeights, score, herCap);
        if (deltas.length === 0) continue;

        // A5: multiply by the composite state modifiers AT JUDGE TIME,
        // plus 待办5③: 「护着」 adds anger ×1.1 only for about='other'.
        const mods = States.compositeMod(state.states);
        const activeStateNote = States.formatActive(state.states);
        const herLabel = await empathy.labelFor(herResult.key);
        const adjusted = deltas.map(d => {
          const factor = (mods[d.base] ?? 1) * States.protectionFactor(state.states, about, d.base);
          return {
            base: d.base,
            delta: Math.round(d.delta * factor * 10) / 10,
            cap: herCap, // A4: carry the per-emotion cap into the queue
            origDelta: factor !== 1 ? d.delta : undefined,
            stateNote: factor !== 1
              ? `${activeStateNote} ×${factor.toFixed(1)}`
              : '—'
          };
        });

        // State trigger (activation affects later entries only). Logged
        // immediately — activation takes effect at once, no decay concept.
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

        if (score > 20) strongTrigger = true;

        // A7: the main rows are written at SETTLEMENT (settleEntries), with
        // record time + effective time. Here we only queue the context.
        newEntries.push({
          deltas: adjusted,
          ts: now,
          label: `${herLabel} ${herResult.key}`,
          reason: (hisEmotion.evidence || text).slice(0, 70)
        });
      }

      if (newEntries.length > 0) {
        if (strongTrigger) {
          // Immediate settlement (SPEC 5.3): whole queue + this message.
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

    agentCtx.on('agent/inbox/inserted', (p) => {
      handleMessage(p.agent, p.message).catch(err => {
        ctx.logger?.warn?.('[dsh-mood] handleMessage error:', err);
      });
    });
  });

  // C2: one shared disposal listener instead of one per agent.
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
    const saveNow = async () => {
      stateDirty = false;
      lastStateSaveAt = Date.now();
      await store.saveState(state);
    };
    toolDisposers = registerTools(ctx, store, baselineRef, () => state, saveNow);
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
    if (stateDirty && state) {
      store.saveState(state).catch(() => {});
    }
  };
}