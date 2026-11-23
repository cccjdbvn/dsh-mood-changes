import Schema from '@deepseek-ai/schemastery';
import { appendFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { MoodStore } from './lib/store.js';
import { MoodPool } from './lib/pool.js';
import { Judge } from './lib/judge.js';
import { Emotions } from './lib/emotions.js';
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
  judgeContextPath: Schema.string().default('').description('判官语境文件路径（她是谁/性格/误判纠偏笔记，Markdown）；留空 = 无语境；每次判句读取，改完即生效'),
  judgeTimeout: Schema.number().default(6000).description('判句请求超时（毫秒）'),
  judgeTemperature: Schema.number().default(0.3).description('判官采样温度'),
  tickIntervalMs: Schema.number().default(900000).description('tick 间隔（毫秒，默认 15 分钟）'),
  ownerNames: Schema.array(Schema.string()).default([]).description('主人在 QQ 消息里的显示名；群聊一律不降思念，私聊且名字在列表里才降'),
  targetSessionId: Schema.string().default('').description('只认这个会话的消息流（她的会话 id）；留空 = 所有会话都算她的（工作会话会被误入账）'),
});

/** Extract plain text from a message whose content may be a string or blocks. */
function textOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
  return '';
}

/** Timer APIs (ctx.interval) require the timer service as a declared dependency. */
export const inject = ['timer'];

export function apply(ctx, config) {
  const worldDir = config.worldDir;
  if (!worldDir) {
    ctx.logger?.warn?.('[dsh-mood] worldDir not configured; plugin inactive');
    return;
  }

  const store = new MoodStore(worldDir);
  const judge = new Judge(config);
  const emotions = new Emotions();
  const log = new MoodLog(worldDir);
  const ownerNames = config.ownerNames || [];

  // Mutable state (loaded from disk on start)
  let state = null;

  // Single source of truth for the baseline: the mood_baseline tool writes
  // into this ref, and tick() reads from it (KNOWN-ISSUES A3).
  const baselineRef = { current: { happy: 15, sad: 5, fear: 5, anger: 0, surprise: 0, disgust: 5 } };

  // Per-agent status bar instances
  const statusBars = new Map();

  // State write-back throttle: at most once every 3 minutes from message flow
  const STATE_SAVE_INTERVAL = 180000; // 3 min
  let lastStateSaveAt = 0;
  let stateDirty = false;

  // Judge context (user decision 2026-11-23): a small, clean context the
  // judge owns — rounds of dialogue (user side + her side), never shared
  // with the agent's own context. A 20-minute activity CD: any message
  // refreshes it; no new reply for 20 minutes after her last one clears it.
  const CONTEXT_CD_MS = 20 * 60000;
  const CONTEXT_MAX_TURNS = 5;
  const turnBuffer = []; // [{lines: ['用户：…', '她：…'], ts}]
  let lastActivityAt = 0;

  // Per-session turn bookkeeping (one emotion pool, many sessions):
  // user messages collected during the open turn + her streamed reply.
  const turnUserTexts = new Map(); // sessionId -> [{text, isOwner}]
  const pendingReplies = new Map(); // sessionId -> string

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

  /** Push one dialogue round into the judge context. */
  function pushTurn(lines, now) {
    if (lines.length === 0) return;
    turnBuffer.push({ lines, ts: now });
    while (turnBuffer.length > CONTEXT_MAX_TURNS) turnBuffer.shift();
  }

  /** Recent rounds (within the CD), oldest first, as flat lines. */
  function windowLines(now) {
    const lines = [];
    for (const turn of turnBuffer) {
      if (now - turn.ts > CONTEXT_CD_MS) continue;
      lines.push(...turn.lines);
    }
    return lines;
  }

  /** CD housekeeping: a silent 20 minutes clears the judge context. */
  function expireJudgeContext(now) {
    if (lastActivityAt && now - lastActivityAt >= CONTEXT_CD_MS && turnBuffer.length > 0) {
      turnBuffer.length = 0;
    }
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

    // 0. Judge-context CD: a silent 20 minutes clears it.
    expireJudgeContext(now);

    // 1. Decay toward the CURRENT baseline (A3), holding skipDecay bases
    //    (「轻快」: happy skips 2 ticks of decay).
    const skipBases = States.consumeSkipDecay(state.states, now);
    state.values = MoodPool.decay(state.values, baselineRef.current, dtMs, skipBases);

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

    // 7. Save (flush any dirty state from the message flow as well)
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

  // --- Baseline file watcher (user decision 2026-11-23) ---
  // Whenever mood/baseline.json changes — the mood_baseline tool, a hand
  // edit, anything — reload it and run ONE sync: values below the new
  // baseline are lifted up to it, values above it stay (her current higher
  // emotion is kept). Debounced: editors and atomic writes (tmp+rename)
  // fire several events for one change.
  const BASES = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust'];
  let baselineDebounce = null;
  async function syncBaselineFromFile() {
    try {
      const fresh = await store.loadBaseline();
      baselineRef.current = fresh;
      if (state) {
        let changed = false;
        for (const base of BASES) {
          const target = fresh[base] ?? 0;
          if ((state.values[base] ?? 0) < target) {
            state.values[base] = target;
            changed = true;
          }
        }
        if (changed) fireAndForget(store.saveState(state));
      }
    } catch (e) { /* a half-written file mid-save: the next event retries */ }
  }
  function scheduleBaselineSync() {
    if (baselineDebounce) clearTimeout(baselineDebounce);
    baselineDebounce = setTimeout(() => { baselineDebounce = null; syncBaselineFromFile(); }, 400);
  }
  let baselineWatcher = null;
  try {
    baselineWatcher = watch(store.moodDir(), (event, filename) => {
      if (filename && !filename.startsWith('baseline.json')) return;
      scheduleBaselineSync();
    });
  } catch (e) { /* mood dir may not exist yet; the tool path still works */ }

  // --- Message flow (session/event): user side ---

  /**
   * B1: who counts as the owner?
   *  - DSH composer (no plugin kind) → owner
   *  - QQ bridge private chat + name in ownerNames → owner
   *  - group chat or anyone else → not the owner (missing never drops)
   */
  function ownerFromSource(kind, text) {
    if (!kind || kind === 'user') return true;
    if (kind.startsWith('plugin:')) {
      const m = text.match(/^\[QQ[^\]]*\]\s*([^：:]{1,40})[：:]/);
      if (m) {
        const who = m[1].trim();
        const isPrivate = text.startsWith('[QQ · 私聊]');
        return isPrivate && ownerNames.includes(who);
      }
    }
    return false;
  }

  function onUserMessage(sessionId, msg, now) {
    if (!state) return;

    const source = msg?.source || {};
    const kind = typeof source.kind === 'string' ? source.kind : '';

    // B2: skip our own injections (status bars and knocks) by source marker.
    if (kind === 'plugin:dsh-mood') return;

    const text = textOf(msg);
    if (!text.trim()) return;

    lastActivityAt = now; // any message refreshes the judge-context CD

    const isOwner = ownerFromSource(kind, text);

    // Collect for the open turn (fed to the judge at turn/end).
    let users = turnUserTexts.get(sessionId);
    if (!users) { users = []; turnUserTexts.set(sessionId, users); }
    users.push({ text, isOwner });

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

    // Missing drop: only owner. A real drop is a state change worth
    // persisting at once (not through the 3-min throttle).
    if (isOwner) {
      const dropped = Missing.drop(state.missing, now);
      if (dropped > 0) {
        stateDirty = false;
        lastStateSaveAt = now;
        fireAndForget(store.saveState(state));
      }
    }

    if (logBatch.length > 0) fireAndForget(log.appendBatch(logBatch));

    // Throttled save: write at most once per 3 minutes
    stateDirty = true;
    saveStateIfDirty(now).catch(() => {});
  }

  // --- Message flow (session/event): her side ---

  function onAssistantMessage(sessionId, event, now) {
    if (!state) return;
    const data = event?.data ?? {};
    const text = textOf(data.message);
    if (!text) return;

    lastActivityAt = now;

    // surfaceOp is a TOP-LEVEL field (same level as type/seq/time/data).
    // {op:'replace', …} means this message replaces streamed content, so
    // rebase instead of appending (same lesson as qq-bridge).
    const prev = pendingReplies.get(sessionId) || '';
    pendingReplies.set(sessionId,
      event.surfaceOp && event.surfaceOp !== 'append'
        ? text
        : prev ? `${prev}\n${text}` : text);
  }

  // --- Judge one turn (fires when her reply settles, turn/end) ---

  async function onTurnEnd(sessionId, now) {
    if (!state) return;

    const users = turnUserTexts.get(sessionId) || [];
    const reply = pendingReplies.get(sessionId) || '';
    turnUserTexts.delete(sessionId);
    pendingReplies.delete(sessionId);

    const userTexts = users.map(u => u.text).filter(t => t && t.trim());
    const roundLines = [];
    for (const t of userTexts) roundLines.push(`用户：${t}`);
    if (reply) roundLines.push(`她：${reply}`);

    // The judge's second-level window is the rounds BEFORE this one; capture
    // it before this round enters the context.
    const priorWindow = windowLines(now);

    // The round enters the judge context regardless of whether we judge.
    pushTurn(roundLines, now);

    // She did not speak this turn → no sampling point (user decision
    // 2026-11-23: judge fires each time SHE speaks; her silence keeps the
    // user lines in the window for the next round's second-level look).
    if (!reply) return;

    const roundText = roundLines.join('\n');
    const fallbackText = userTexts.join('\n');

    let result = null;
    try {
      result = await judge.judge(roundText, priorWindow, fallbackText);
    } catch (e) {
      ctx.logger?.warn?.('[dsh-mood] judge error:', e);
      return;
    }
    if (!result) return;

    await consumeJudge(result, users, now);
  }

  // --- Consume the judge verdict: HER emotion straight into the pool ---

  async function consumeJudge(result, roundUsers, now) {
    if (!result.emotions || result.emotions.length === 0) return;

    const about = result.about || 'unknown';
    const isOwnerRound = roundUsers.some(u => u.isOwner); // when:'fromUser'
    let strongTrigger = false;
    const newEntries = [];
    const logBatch = [];
    let lonelyHit = false;

    for (const herEmotion of result.emotions) {
      const key = herEmotion.key;
      const label = await emotions.labelFor(key);

      // closeOnly (SPEC 4.1): shy's happy weight only applies when the
      // emotion is directed at the user; otherwise zero it and renormalize.
      const closeOnly = await emotions.closeOnlyFor(key);
      const rawWeights = await emotions.weightsFor(key);
      const weights = Emotions.adjustCloseOnly(rawWeights, closeOnly, about === 'her');

      const cap = await emotions.capFor(key);
      const score = herEmotion.intensity * cap;
      if (score < 0.15 * cap) continue;

      const deltas = MoodPool.calculateWeighted(weights, score, cap);
      if (deltas.length === 0) continue;

      // A5: multiply by the composite state modifiers AT JUDGE TIME,
      // plus 待办5③: 「护着」 adds anger ×1.1 only when about='other' (her
      // anger directed at someone else).
      const mods = States.compositeMod(state.states);
      const activeStateNote = States.formatActive(state.states);
      const adjusted = deltas.map(d => {
        const factor = (mods[d.base] ?? 1) * States.protectionFactor(state.states, about, d.base);
        return {
          base: d.base,
          delta: Math.round(d.delta * factor * 10) / 10,
          cap, // A4: carry the per-emotion cap into the queue
          origDelta: factor !== 1 ? d.delta : undefined,
          stateNote: factor !== 1
            ? `${activeStateNote} ×${factor.toFixed(1)}`
            : '—'
        };
      });

      // State trigger (activation affects later entries only). Logged
      // immediately — activation takes effect at once, no decay concept.
      const stateDef = await emotions.stateFor(key);
      if (stateDef) {
        if (stateDef.when === 'fromUser' && !isOwnerRound) continue;
        States.activate(state.states, stateDef, now, key);
        logBatch.push({
          ts: now, block: '状态', emotion: stateDef.name,
          delta: 0,
          reason: `触发：${label}`,
          stateNote: `${stateDef.minutes || 60}min`
        });
        strongTrigger = true;
      }

      // alsoMissing (SPEC 4.1): she reads as lonely → extra missing gain.
      if (await emotions.alsoMissingFor(key)) lonelyHit = true;

      if (score > 20) strongTrigger = true;

      // A7: the main rows are written at SETTLEMENT (settleEntries), with
      // record time + effective time. Here we only queue the context.
      newEntries.push({
        deltas: adjusted,
        ts: now,
        label: `${label} ${key}`,
        reason: (herEmotion.evidence || '').slice(0, 70)
      });
    }

    if (lonelyHit) {
      const gain = Missing.lonelyBonus(state.missing);
      logBatch.push({
        ts: now, block: '思念', emotion: '思念',
        delta: Math.round(gain * 10) / 10,
        reason: '孤独：她开始想主人',
        stateNote: States.formatActive(state.states) || '—'
      });
    }

    if (newEntries.length > 0) {
      if (strongTrigger) {
        // Immediate settlement (SPEC 5.3): whole queue + this verdict.
        settleEntries([...store.drainQueue(state), ...newEntries], now);
      } else {
        for (const e of newEntries) store.enqueue(state, e);
      }
    }

    if (logBatch.length > 0) fireAndForget(log.appendBatch(logBatch));

    // A judged verdict with real deposits is a state change: save at once,
    // bypassing the 3-min user-message throttle (a crash in the throttle
    // window would otherwise lose ledger rows that the log already claims).
    if (newEntries.length > 0 || lonelyHit) {
      stateDirty = false;
      lastStateSaveAt = now;
      fireAndForget(store.saveState(state));
    } else {
      // Throttled save: write at most once per 3 minutes
      stateDirty = true;
      saveStateIfDirty(now).catch(() => {});
    }
  }

  // --- session/event wiring (post-commit feed, qq-bridge pattern) ---
  // Every ctx.on returns a disposer; collect them so a fiber reload removes
  // ALL listeners (a leaked listener = double judging / stale handlers).
  const offSessionEvent = ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id;
      if (!sessionId || !event || typeof event.type !== 'string') return;
      // Only ONE session is "her": with targetSessionId set, everything else
      // (work sessions, tooling sessions) stays out of her mood ledger.
      if (config.targetSessionId && sessionId !== config.targetSessionId) return;
      const now = Date.now();

      if (event.type === 'user/message') {
        // data is the UserMessage itself (or wrapped {turn,step,message}).
        const msg = event.data?.message ?? event.data;
        onUserMessage(sessionId, msg, now);
        return;
      }

      if (event.type === 'assistant/message') {
        onAssistantMessage(sessionId, event, now);
        return;
      }

      if (event.type === 'turn/end') {
        fireAndForget(onTurnEnd(sessionId, now));
        return;
      }
    } catch (e) {
      ctx.logger?.warn?.('[dsh-mood] session/event error:', e);
    }
  });

  // Per-session maps must not leak after a session leaves the registry.
  const offSessionDisposed = ctx.on('session/disposed', (session) => {
    turnUserTexts.delete(session?.id);
    pendingReplies.delete(session?.id);
  });

  // --- Agent lifecycle (status bars only; judging lives on session/event) ---
  const offAgentCreated = ctx.on('agent/created', (payload) => {
    const { agent } = payload;
    if (!agent?.ctx) return;
    statusBars.set(agent.id, new StatusBar(agent));
  });

  // C2: one shared disposal listener instead of one per agent.
  const offAgentDisposed = ctx.on('agent/disposed', (p) => {
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
  let routeDisposers = [];
  try {
    routeDisposers = registerRoutes(ctx, store, baselineRef, () => state);
  } catch (e) {
    ctx.logger?.warn?.('[dsh-mood] route registration error:', e);
  }

  // --- Tools/result → boredom drop ---
  // 会话归属判定（用户 2026-11-23）：思念/无聊的降值只认她的会话——别的会话
  // （比如工作会话）调工具不再降她的无聊。tools/result 是 Scoped<ToolsService>
  // 事件，this 绑定发起 agent 的 scope；多路径提取 sessionId，取不到时维持
  // 旧行为（降），取到且不是她的会话则跳过。附带一次性诊断日志（形状确认后删）。
  const offToolsResult = ctx.on('tools/result', function (exec) {
    if (!state) return;
    let sessionId = null;
    let source = 'none';
    try {
      const scoped = this;
      if (scoped?.scope?.session?.id) { sessionId = scoped.scope.session.id; source = 'this.scope.session.id'; }
      else if (scoped?.session?.id) { sessionId = scoped.session.id; source = 'this.session.id'; }
      else if (exec?.agent?.session?.id) { sessionId = exec.agent.session.id; source = 'exec.agent.session.id'; }
      else if (exec?.agent?.id) { sessionId = exec.agent.id; source = 'exec.agent.id'; }
      else if (exec?.sessionId) { sessionId = exec.sessionId; source = 'exec.sessionId'; }
    } catch {}
    // TEMP DIAG（本机一次性诊断，结构确认后删除）
    try {
      appendFileSync('F:/DSH/work/_tmp/tools-result-shape.log',
        `${new Date().toISOString()} source=${source} sessionId=${sessionId} execKeys=${Object.keys(exec || {}).slice(0, 20).join('|')}\n`);
    } catch {}
    if (config.targetSessionId && sessionId && sessionId !== config.targetSessionId) return;
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
  // Remove EVERYTHING this fiber registered: leaked listeners would double-
  // judge turns and stale route handlers would keep answering with stale
  // state after a reload.
  return () => {
    tickInterval();
    for (const d of toolDisposers) d();
    for (const d of routeDisposers) { try { d(); } catch {} }
    for (const off of [offSessionEvent, offSessionDisposed, offAgentCreated, offAgentDisposed, offToolsResult]) {
      if (typeof off === 'function') { try { off(); } catch {} }
    }
    if (baselineDebounce) clearTimeout(baselineDebounce);
    if (baselineWatcher) { try { baselineWatcher.close(); } catch {} }
    if (stateDirty && state) {
      store.saveState(state).catch(() => {});
    }
  };
}
