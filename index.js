import Schema from '@deepseek-ai/schemastery';
import { watch } from 'node:fs';
import { join, normalize } from 'node:path';
import { MoodStore } from './lib/store.js';
import { MoodPool } from './lib/pool.js';
import { toY, toX } from './lib/happy.js';
import { Judge } from './lib/judge.js';
import { Emotions } from './lib/emotions.js';
import { MoodLog } from './lib/log.js';
import { JudgeLog } from './lib/judge-log.js';
import { Coupling } from './lib/coupling.js';
import { Missing } from './lib/missing.js';
import { Boredom } from './lib/boredom.js';
import { States } from './lib/states.js';
import { StatusBar } from './lib/statusbar.js';
import { DEFAULT_TUNING, loadTuning } from './lib/tuning.js';
import { registerRoutes } from './lib/routes.js';
import { registerSettingsRoutes } from './lib/config-api.js';import { registerTools } from './lib/tools.js';

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
  targetSessionId: Schema.string().default('').description('只认这个会话的消息流（她的会话 id）；留空 = 所有会话都算她的（工作会话会被误入账）。配了 targetWorkspaceDir 时以目录为准'),
  targetWorkspaceDir: Schema.string().default('').description('按工作目录自动认家：找该目录下最新创建、未归档、活着的根会话；投送状态条/敲门、判句来源、思念/无聊降值都用它。配了它就不用 targetSessionId；留空 = 退回按会话 id'),
});

/** Extract plain text from a message whose content may be a string or blocks. */
function textOf(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
  return '';
}

/** Timer APIs (ctx.interval) require the timer service as a declared dependency. */
export const inject = ['timer', 'webServer', 'systemPrompt'];

/**
 * 谁是主人（E24，2026-11-24 用户明确）：
 *  - **桌面端输入框来的消息默认就是主人**——不管 source.kind 是 'user'、空、
 *    还是客户端自己别的标记，只要不是插件注入，一律当主人（思念降值）。
 *  - **QQ 端认主人**：只有 QQ 桥注入的私聊消息、且昵称在 ownerNames 里才算；
 *    群聊、别人、解析不出昵称的都不算（思念不降）。
 * 导出成模块顶层函数，方便测试直接跑。
 * @param {string} kind - message.source.kind
 * @param {string} text - 消息正文
 * @param {string[]} names - 主人昵称表（config.ownerNames）
 * @returns {boolean}
 */
export function ownerFromSource(kind, text, names = []) {
  const k = typeof kind === 'string' ? kind : '';
  // 0.2.0 的插件 source 是 `plugin:<包名>`；老格式是 `plugin`。
  const isPluginSource = k === 'plugin' || k.startsWith('plugin:');
  if (!isPluginSource) return true; // 桌面端输入 / 系统 / 客户端 → 主人
  const m = String(text ?? '').match(/^\[QQ[^\]]*\]\s*([^：:]{1,40})[：:]/);
  if (!m) return false; // 插件注入但不是 QQ 消息 → 不算主人
  const who = m[1].trim();
  const isPrivate = String(text).startsWith('[QQ · 私聊]');
  return isPrivate && names.includes(who);
}

/** QQ 桥注入消息的 source.kind（0.2.0 producer-owned 形状）。 */
export const QQ_BRIDGE_KIND = 'plugin:dsh-qq-bridge';

/** 判官单段文本的上限：只防长摘要把 vLLM 的小上下文撑爆，不改内容。 */
function capJudgeText(s, max = 2000) {
  const text = typeof s === 'string' ? s.trim() : '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 客户端/宿主自己注入的脚手架：不是她经历的事，不进判句（2026-11-25 扫描后定）。 */
const JUDGE_SKIP_KINDS = new Set([
  'runtime-context', // 会话环境快照（每回合）
  'time-context', // 时间戳（每回合）
  'agent-instructions', // 工作区指令 / AGENTS.md
  'skill-catalog', // 技能清单
  'tool-jobs', // 后台任务完成通知
  'subagent-settled', // 子代理结束通知
  'agent-message', // 代理之间传话
  'user-approval', // 审批策略变更
  'model-selection', // 换模型提示
  'repeat-tool-reminder', // 重复调用提醒
  'compact-checkpoint', // 压缩摘要
  'dsh-world-history', // 最近 200 轮聊天记录（上下文，不是新事件）
  'dsh-world-mood', // 旧版心情值快照
  'dsh-world-summary-input', // 世界摘要的模型输入
  'dsh-world-prompt-merge', // 世界提示词融合的模型输入
  'mood-lian', // 旧版情绪插件的快手号
  'plugin:dsh-mood-changes', // 我自己的状态条/敲门
  'dsh-world-channel-context', // 同线回忆/图片补充：引用数据，不是新事件
  'dsh-world-reply-nudge', // 催她回复的系统提示
  'dsh-world-wechat-delivery', // 微信发送回执/被拒说明
  'dsh-world-wechat-outgoing', // 微信出站回显
]);

/**
 * 判句行（E27，2026-11-25 用户要求）：每条入站消息定一个「谁在说」的行，
 * 按时间顺序拼给判官（#4）。来源区分（#3）在这里落地：
 *
 * - QQ 桥（`plugin:dsh-qq-bridge`，含旧版 `plugin` + `[QQ` 开头）：拆掉
 *   `[QQ · 私聊]` 前缀和「（回 QQ 用…）」指令行；**昵称在 ownerNames 里（且私聊）
 *   → `用户：内容`**，别人 → `昵称：内容`（群里也一样，群名不带进去）。#5/#6
 * - 世界生活线（`dsh-world-life`）→ `【生活线】…`：定时提醒，不是用户说的。
 * - 定时任务（`schedule`）→ `【定时任务】…`；世界在外的通知 → `【世界】…`。
 * - 客户端/宿主脚手架（见 `JUDGE_SKIP_KINDS`）不进判句。
 * - 其它（桌面端输入、rpc、空 kind…）→ `用户：内容`。
 * @param {string} kind - message.source.kind
 * @param {string} text - 消息正文
 * @param {boolean} isOwner - ownerFromSource 的结果
 * @returns {string} 判句行；不需要进判句的返回 ''
 */
export function judgeLineFor(kind, text, isOwner = false) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return '';
  if (JUDGE_SKIP_KINDS.has(kind)) return '';
  if (kind === QQ_BRIDGE_KIND || (kind === 'plugin' && raw.startsWith('[QQ'))) return qqJudgeLine(raw, isOwner);
  if (kind === 'dsh-world-life') return `【生活线】${capJudgeText(raw, 800)}`;
  if (kind === 'schedule') return `【定时任务】${capJudgeText(raw, 800)}`;
  if (kind === 'dsh-world-elsewhere') return `【世界】${capJudgeText(raw, 800)}`;
  if (kind === 'dsh-world-outside') return `【世界】${capJudgeText(raw, 800)}`; // 门口/外面的动静（form:'ring'），是她经历的，但不是谁说的话
  return `用户：${capJudgeText(raw, 1200)}`;
}

/** QQ 桥消息 → 「用户：…」/「昵称：…」；未唤醒摘要保留成一段带标记的文本。 */
function qqJudgeLine(raw, isOwner) {
  // 出站被拒的系统回执（[QQ 出站被拒] …）不是谁说的话，不进判句。
  if (/^\s*\[QQ\s*出站被拒\]/.test(raw)) return '';
  // 桥贴在每条入站下面的「回 QQ 怎么回」指令行，判官不需要。
  const body = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*[（(]\s*回\s*QQ/.test(line))
    .join('\n')
    .trim();
  if (!body) return '';
  // 未唤醒期间的聊天记录摘要：内部已经带「昵称: 内容」，整体标注来源即可。
  if (/^\[QQ 未唤醒期间聊天记录/.test(body)) return `【QQ 聊天记录】${capJudgeText(body, 1500)}`;
  const noPrefix = body.replace(/^\[QQ[^\]]*\]\s*/, '');
  const m = noPrefix.match(/^([^：:\n]{1,40})[：:]\s*([\s\S]*)$/);
  if (!m) return capJudgeText(noPrefix, 1200);
  const who = m[1].trim();
  const said = m[2].trim();
  return `${isOwner ? '用户' : who}：${capJudgeText(said, 1200)}`;
}

/**
 * 她这一轮用 qq_bridge_send 工具发去 QQ 的文本（E25，只读工具参数）。
 * tools/result 的 exec.arguments 是工具参数对象（个别宿主给 JSON 串）。
 * @param {object} exec - tools/result 的 ToolExec
 * @returns {string} 发出的文本；不是这个工具/没正文 → ''
 */
export function qqSendTextOf(exec) {
  if (!exec || exec.name !== 'qq_bridge_send') return '';
  let args = exec.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return ''; }
  }
  return capJudgeText(typeof args?.text === 'string' ? args.text : '');
}

/**
 * 拼判官这一轮的行（E27）：所有入站行按时间排（生活线 / QQ / 桌面端 / 工具
 * 发出的话混在一起，谁先谁后一目了然），最后是她的回复。工具发出去的话若
 * 已经在她的回复里，不重复喂。
 * @param {{ts?:number, kind?:string, line?:string, text?:string}[]} events
 * @param {string} reply
 * @returns {string[]}
 */
export function buildRoundLines(events, reply) {
  const lines = [];
  const sorted = [...(events || [])].sort((a, b) => (a?.ts ?? 0) - (b?.ts ?? 0));
  const herText = (typeof reply === 'string' ? reply : '').trim();
  for (const e of sorted) {
    const line = typeof e?.line === 'string' ? e.line.trim() : '';
    if (!line) continue;
    if (e.kind === 'send' && herText && e.text && herText.includes(e.text)) continue;
    lines.push(line);
  }
  if (herText) lines.push(`她：${capJudgeText(herText, 2000)}`);
  return lines;
}

export function apply(ctx, config) {
  const worldDir = config.worldDir;
  if (!worldDir) {
    ctx.logger?.warn?.('[dsh-mood-changes] worldDir not configured; plugin inactive');
    return;
  }

  const store = new MoodStore(worldDir);
  const judge = new Judge(config);
  const emotions = new Emotions();
  const log = new MoodLog(worldDir);
  // 判官判定记录：独立文件，判官每次调用都落一行（含「判了但没变化」）。
  const judgeLog = new JudgeLog(worldDir);
  const ownerNames = config.ownerNames || [];

  // 六情上下文（E28，2026-11-25 用户要求）：六情的提示不再作为一条 user 消息
  // 塞进会话（那会显示成「收到执行请求」），改成注册一段运行时上下文——只在
  // 每步装配时进 prompt，不触发回合、不占聊天记录。
  // 护栏：任一情绪 > 40 才有内容；距上次刷新满 1.5 小时才换新内容。
  let moodContextText = '';
  let offMoodContext = null;
  try {
    const promptService = ctx.systemPrompt ?? ctx.get('systemPrompt');
    if (promptService && typeof promptService.context === 'function') {
      offMoodContext = promptService.context({
        name: 'dsh-mood-changes/status',
        order: 900,
        text: () => moodContextText
      });
    }
  } catch (e) {
    ctx.logger?.warn?.('[dsh-mood-changes] context registration error:', e);
  }

  // Mutable state (loaded from disk on start)
  let state = null;

  // 运行参数（2026-11-24）：思念/无聊的增速、衰减冷却、夜间窗口。
  // 存 worldDir/mood/tuning.json，设置页改完即时生效（不重启插件）。
  let tuning = JSON.parse(JSON.stringify(DEFAULT_TUNING));

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
  const turnUserTexts = new Map(); // sessionId -> [{ts, kind, isOwner, text, line}]
  const pendingReplies = new Map(); // sessionId -> string
  const qqSends = new Map(); // sessionId -> string[]（这一轮 qq_bridge_send 发出的文本）

  // 无聊的轮次计数（E30，2026-11-25 用户拍板）：计数单位从「工具调用次数」
  // 改成「调过工具的对话轮」。A 那轮记第 0 轮；这两个标记记的是「本轮状态」，
  // 在 turn/end 消费后清掉（会话销毁时也清）。
  const turnHasWork = new Map(); // sessionId -> 本轮是否调用过 qq_bridge_send 以外的工具
  const aTurn = new Map(); // sessionId -> 本轮是否有 A（无聊衰减）落地（A 那轮 = 第 0 轮，不计数）

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
    // 「乐」改为内部账 y + 显示映射 x（2026-11-26 用户拍板）：老 state 里 happy 存的是
    // 显示值，第一次加载时换算成 y 并打标记，避免每次启动都重复换算。
    if (state && state.happyModel !== 2) {
      const oldX = state.values?.happy ?? 15;
      if (!state.values) state.values = {};
      state.values.happy = toY(oldX);
      state.happyModel = 2;
    }
    baselineRef.current = await store.loadBaseline();
    tuning = await loadTuning(worldDir);
    // 2026-11-25（E27）：把它当作「刚醒来」——不这么设，插件一启动就看到
    // lastActivityAt=0，夜里也会按小时往 inbox 里排状态条，早上第一次醒时
    // 几条一起被 splice（「连续三次执行请求、数值还各不相同」）。
    lastActivityAt = Date.now();
    if (!state.queue) state.queue = [];
    // Backfill newer fields on old state files.
    if (!state.missing) state.missing = { value: 0, lastDropAt: 0, lastNotifyAt: 0, lastRoll: 0, lastHitAt: 0, manualDay: '', manualSum: 0 };
    if (!state.missing.lastNotifyAt) state.missing.lastNotifyAt = 0;
    if (!state.missing.lastRoll) state.missing.lastRoll = 0;
    if (state.missing.lastRollHit === undefined) state.missing.lastRollHit = false;
    if (!state.boredom) state.boredom = { value: 0, lastMsgAt: 0, lastToolAt: 0 };
    if (!state.boredom.lastNotifyAt) state.boredom.lastNotifyAt = 0;
    if (!state.boredom.lastRoll) state.boredom.lastRoll = 0;
    if (state.boredom.lastRollHit === undefined) state.boredom.lastRollHit = false;
    // 六情上下文上次刷新时间（E28 起；0 = 从没刷新过）
    if (state.lastStatusAt === undefined) state.lastStatusAt = 0;
    // 无聊轮次计数的回填（E30，2026-11-25 起）：countStartAt = 最近一次 A 的
    // 时刻（0 = 没开窗），turnCount = A 之后已数到第几个「调过工具的轮」。
    if (state.boredom.countStartAt === undefined) state.boredom.countStartAt = 0;
    if (state.boredom.turnCount === undefined) state.boredom.turnCount = 0;
    // E33：最近一次 A（或 B）的时刻，A 的 1h CD 从这里算（0 = 没有 CD）
    if (state.boredom.lastAAt === undefined) state.boredom.lastAAt = 0;
    // 回滚标记队列的回填（2026-11-24 起，E7b）
    if (!Array.isArray(state.pendingRollback)) state.pendingRollback = [];
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
    if (!entries || entries.length === 0) return [];
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
    }

    MoodPool.clamp(state.values);
    if (logBatch.length) fireAndForget(log.appendBatch(logBatch));
    return logBatch;
  }

  /**
   * 主动核算（2026-11-24 用户需求）：只把队列里积的判句事件结算掉——
   * 真正入账（delta + 耦合传播 + 写主条/传播行日志 + 由调用方落盘），
   * 但**不做时间衰减**、不推进 lastTickAt、不跑思念/无聊、不掷骰、不注入。
   * 无冷却，可连调。和 tick 的区别：tick 是「衰减 + 结算 + 时间线 + 敲门 + 注入」，
   * 核算只做中间那一步。
   * @returns {{queued:number, rows:object[], changes:Record<string,number>, values:Record<string,number>}}
   */
  function settleQueueNow(now) {
    const before = { ...state.values };
    const queued = (state.queue || []).length;
    const rows = settleEntries(store.drainQueue(state), now) || [];
    const changes = {};
    for (const base of Object.keys(before)) {
      const d = Math.round(((state.values[base] ?? 0) - (before[base] ?? 0)) * 10) / 10;
      if (Math.abs(d) > 0.001) changes[base] = d;
    }
    return { queued, rows, changes, values: { ...state.values } };
  }

  // --- Knock (掷骰敲门): missing / boredom ask to interact ---

  /**
   * 敲一次门（带搭车摘要），只发给她那个 agent。
   * E29（2026-11-25）：返回实际交付数——交付成功才让调用方记 `lastNotifyAt`，
   * 否则这次「掷中」会被白白吃掉（12:55 那次就是插进 inbox 没人醒）。
   */
  function knock(text, now) {
    const full = text + buildSummary(now);
    const agents = ctx.get('agents');
    const target = targetSessionId();
    let delivered = 0;
    if (agents) {
      for (const agent of agents.list()) {
        if (!isHerAgent(agent, target)) continue;
        const sb = statusBars.get(agent.id);
        if (sb && sb.knock(full)) delivered++;
      }
    }
    if (delivered > 0) {
      resetSummary(now);
      state.lastInjectAt = now; // a knock also opens a new summary segment
    }
    return delivered;
  }

  function tryKnock(now) {
    // 「有气无力」 skips dice rolls entirely (SPEC 5.5).
    if (States.hasSkipRoll(state.states)) return;

    const m = state.missing;
    if (!(m.lastNotifyAt && now - m.lastNotifyAt < 60 * 60000) && Missing.shouldKnock(m, now, tuning)) {
      const v = (m.value || 0).toFixed(1);
      const delivered = knock(m.value >= 80
        ? `思念 ${v}，好些时候没和主人说话了。`
        : `思念 ${v}，要不要和主人说句话？`, now);
      if (delivered > 0) m.lastNotifyAt = now;
    }

    const b = state.boredom;
    if (!(b.lastNotifyAt && now - b.lastNotifyAt < 60 * 60000) && Boredom.shouldKnock(b, now, tuning)) {
      const delivered = knock(`无聊 ${(b.value || 0).toFixed(1)}，要不要自己做点什么？`, now);
      if (delivered > 0) b.lastNotifyAt = now;
    }
  }

  // --- Boredom 轮次结算（E30，2026-11-25 用户拍板） ---
  //
  // A = 任何一次非计数触发的无聊衰减（消息 ×0.7 / 工具 ×0.6）真正落地；A 一
  // 落地就开窗（A 那轮记第 0 轮）。计数单位改成「调过工具的对话轮」——同一轮
  // 里调 48 次工具也只算这一轮。A 后一个窗口（默认 1 小时）内数到第 5 轮 →
  // 触发一次 B（×0.6）；B 之后关窗等下一次 A；数到第 5 轮时已超窗口则这次 B
  // 作废（旧实现按调用次数数，16 分钟能连发 6 笔 B —— 见今天的账）。
  function settleBoredomTurn(sessionId, now) {
    if (!state) return;
    const hadWork = turnHasWork.get(sessionId) === true;
    const isATurn = aTurn.get(sessionId) === true;
    turnHasWork.delete(sessionId);
    aTurn.delete(sessionId);

    // A 那一轮是第 0 轮：不 +1。没干过活（只调了 qq_bridge_send 或没调工具）的轮也不 +1。
    const r = Boredom.onTurnEnd(state.boredom, now, hadWork && !isATurn, tuning);
    if (r.expired) {
      stateDirty = true;
      saveStateIfDirty(now).catch(() => {});
      return;
    }
    if (r.b > 0) {
      const secondAt = tuning?.boredom?.toolSecondAt ?? 5;
      fireAndForget(log.append({
        ts: now, block: '无聊', emotion: '无聊',
        delta: -Math.round(r.b * 10) / 10,
        reason: `A 后第 ${secondAt} 轮 ×0.6`
      }));
      // B 是真落账，立即落盘（同 A 的口径）。
      stateDirty = false;
      lastStateSaveAt = now;
      fireAndForget(store.saveState(state));
      return;
    }
    if (r.turnCount > 0) {
      stateDirty = true;
      saveStateIfDirty(now).catch(() => {});
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
    state.values = MoodPool.decay(state.values, baselineRef.current, dtMs, skipBases, tuning);

    // 2. Settle the event queue（只入账，不再逐笔传播；E31）
    settleEntries(store.drainQueue(state), now);

    // 2.5 水位传播（E31，2026-11-25 用户拍板）：只有「自动核算（tick）」这一步
    // 传播一次，依据**结算后的总值**——源 >60 的溢出 × 矩阵系数，目标正向封顶
    // 30 且原本 ≥30 不加。强触发的立即结算与她主动的 mood_settle 都不传播。
    const propagated = Coupling.propagateFromValues(state.values, States.compositeMod(state.states));
    if (propagated.length > 0) {
      fireAndForget(log.appendBatch(propagated.map((p) => ({
        ts: now, effectiveAt: now,
        block: MoodLog.blockForBase(p.base),
        emotion: '传播',
        delta: p.delta,
        reason: `由 ${MoodLog.blockForBase(p.parent)} 传播`,
        stateNote: '—'
      }))));
    }

    // 3. Coupling: tick damping（另一条机制，系数 0，未启用）
    Coupling.dampen(state.values, 0); // Start at 0, increase after a week

    // 4. Missing & Boredom tick
    const missingGain = States.missingGainMultiplier(state.states);
    const missingStep = States.missingStepBonus(state.states);
    const missingResult = Missing.tick(state.missing, now, missingGain, missingStep, tuning);

    const boredomStep = States.boredomStepBonus(state.states);
    Boredom.tick(state.boredom, now, boredomStep, tuning);

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

    // 9. 六情上下文（E28，2026-11-25 用户要求）
    // 不再是「往会话里塞一条状态条消息」——那会显示成「收到执行请求」，还会
    // 在她不在场时排队。现在只更新 `systemPrompt.context` 的文本：
    //   · 任一条 > 40 才有内容；全部 ≤ 40 就把内容清空（别让旧数值一直挂着）
    //   · 距上次刷新满 1.5 小时才换新内容；没到点就保持原样（装配时不会重发）
    if (StatusBar.shouldRefresh(state, now)) {
      moodContextText = StatusBar.buildStatusText(state);
      state.lastStatusAt = now;
      stateDirty = true;
      await store.saveState(state);
    } else if (moodContextText && Math.max(...Object.values(state.values)) <= 40) {
      moodContextText = '';
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

  // --- Target session resolution：targetWorkspaceDir 优先，其次 targetSessionId ---
  //
  // 2026-11-24 用户需求：按工作目录自动认家——该目录下「最新创建、未归档、
  // 活着的根会话」就是她。投送（状态条/敲门）、判句来源、思念/无聊降值
  // 全部用同一个解析结果；换会话后自动跟上，不用再改 session id。
  // 归档判断直接读 workspaceRegistry.archivedSessionIds（DSH 工作区的归档集合）。

  const CASE_INSENSITIVE_FS = process.platform === 'win32';

  /** 目录比较口径：Windows 大小写不敏感，其余原样。 */
  function normDir(p) {
    if (!p) return '';
    const n = normalize(String(p));
    return CASE_INSENSITIVE_FS ? n.toLowerCase() : n;
  }

  function hasSessionRestriction() {
    return Boolean(config.targetWorkspaceDir || config.targetSessionId);
  }

  /** 目录下最新创建、未归档、活着的根会话 id；没有则 null。 */
  function resolveWorkspaceHome() {
    const want = normDir(config.targetWorkspaceDir);
    if (!want) return null;
    const sessions = ctx.get('sessions');
    if (!sessions?.list) return null;
    let archived = [];
    try {
      archived = ctx.get('workspaceRegistry')?.archivedSessionIds || [];
    } catch { /* registry not started yet */ }
    const archivedSet = new Set(archived.map(String));
    let best = null;
    for (const session of sessions.list()) {
      const header = session?.header;
      if (!header) continue;
      if (normDir(header.cwd) !== want) continue;
      if (header.origin === 'subagent' || header.parentSession) continue; // 家是根会话
      if (archivedSet.has(String(session.id))) continue;
      if (!best || (header.createdAt ?? 0) > (best.header.createdAt ?? 0)) best = session;
    }
    return best ? String(best.id) : null;
  }

  /** 当前认的目标会话 id；null = 没配限制，或目录下暂无家。 */
  function targetSessionId() {
    if (config.targetWorkspaceDir) return resolveWorkspaceHome();
    return config.targetSessionId || null;
  }

  /** 这个会话是不是她。没配任何限制 = 所有会话都算。 */
  function isTargetSession(sessionId) {
    if (!hasSessionRestriction()) return true;
    const target = targetSessionId();
    return target !== null && String(sessionId) === target;
  }

  /** 注入目标：只发给她的 agent；没配限制 = 所有 live agent。 */
  function isHerAgent(agent, target = targetSessionId()) {
    if (!hasSessionRestriction()) return true;
    return target !== null && String(agent?.id) === target;
  }

  // --- Message flow (session/event): user side ---
  // 主人判定见模块顶层的 ownerFromSource（导出给测试用）。

  function onUserMessage(sessionId, msg, now) {
    if (!state) return;

    const source = msg?.source || {};
    const kind = typeof source.kind === 'string' ? source.kind : '';

    // B2: skip our own injections (status bars and knocks) by source marker.
    if (kind === 'plugin:dsh-mood-changes') return;

    const text = textOf(msg);
    if (!text.trim()) return;

    lastActivityAt = now; // any message refreshes the judge-context CD

    const isOwner = ownerFromSource(kind, text, ownerNames);

    // Collect for the open turn (fed to the judge at turn/end).
    // line 是给判官看的那一行（已按来源改写：#3/#5/#6），text 原样留着给
    // 主人判定与无聊降值；line 为空（harness 脚手架）时只记账不进判句。
    let users = turnUserTexts.get(sessionId);
    if (!users) { users = []; turnUserTexts.set(sessionId, users); }
    users.push({ ts: now, kind: 'user', isOwner, text, line: judgeLineFor(kind, text, isOwner) });

    const logBatch = [];

    // Boredom drop: any message → ×0.7。E30：这次衰减就是 A，落地即开轮次
    // 窗口（本条消息所在的这一轮 = 第 0 轮）。
    const boredomDrop = Boredom.drop(state.boredom, now, 'msg', tuning);
    if (boredomDrop > 0) {
      Boredom.startCountWindow(state.boredom, now);
      aTurn.set(sessionId, true);
      logBatch.push({
        ts: now, block: '无聊', emotion: '无聊',
        delta: -Math.round(boredomDrop * 10) / 10,
        reason: '有人说话了 ×0.7'
      });
    }

    // Missing drop: only owner. A real drop is a state change worth
    // persisting at once (not through the 3-min throttle).
    if (isOwner) {
      const dropped = Missing.drop(state.missing, now, tuning);
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
    const sends = qqSends.get(sessionId) || [];
    turnUserTexts.delete(sessionId);
    pendingReplies.delete(sessionId);
    qqSends.delete(sessionId);

    // E27（2026-11-25 用户要求）：把这一轮的所有入站按时间顺序送判官——
    // 生活线提醒、QQ 来消息、她用 qq_bridge_send 发出去的话、以及最后的回复。
    const events = users.concat(sends.map((s) => ({
      ts: s.ts,
      kind: 'send',
      text: s.text,
      line: `她：${s.text}`
    })));
    const roundLines = buildRoundLines(events, reply);
    const userTexts = events.filter(e => e.kind === 'user' && e.line).map(e => e.line);

    // The judge's second-level window is the rounds BEFORE this one; capture
    // it before this round enters the context.
    const priorWindow = windowLines(now);

    // The round enters the judge context regardless of whether we judge.
    pushTurn(roundLines, now);

    // She did not speak this turn → no sampling point (user decision
    // 2026-11-23: judge fires each time SHE speaks; her silence keeps the
    // user lines in the window for the next round's second-level look).
    // 只在工具里说话（qq_bridge_send）也算她说了。
    if (!reply && sends.length === 0) return;

    const roundText = roundLines.join('\n');
    const fallbackText = userTexts.join('\n');

    let result = null;
    try {
      result = await judge.judge(roundText, priorWindow, fallbackText);
    } catch (e) {
      ctx.logger?.warn?.('[dsh-mood-changes] judge error:', e);
      fireAndForget(judgeLog.append({
        at: now,
        ok: false,
        stage: 'call',
        error: String(e?.message ?? e),
        round: clipRound(roundText)
      }));
      return;
    }
    if (!result) {
      fireAndForget(judgeLog.append({
        at: now,
        ok: false,
        stage: 'empty',
        error: '判官没有返回结果',
        round: clipRound(roundText)
      }));
      return;
    }

    const applied = await consumeJudge(result, users, now);
    // 无论有没有情绪入账、有没有触发状态，这一条都写。
    fireAndForget(judgeLog.append({
      at: now,
      ok: true,
      clear: result.clear,
      confidence: result.confidence,
      about: result.about,
      emotions: (result.emotions || []).map((e) => ({
        key: e.key,
        intensity: e.intensity,
        evidence: e.evidence
      })),
      applied: applied?.applied ?? [],
      states: applied?.states ?? [],
      skipped: applied?.skipped ?? [],
      verdict: applied?.applied?.length || applied?.states?.length ? 'deposited' : 'no-change',
      round: clipRound(roundText)
    }));
  }

  /** 判定记录里的对话摘要：留 400 字，够认人；不截断进去会撑大 jsonl。 */
  function clipRound(text) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  }

  // --- Consume the judge verdict: HER emotion straight into the pool ---

  async function consumeJudge(result, roundUsers, now) {
    // 摘要只给判官记录用，不改变任何数值行为。
    const applied = [];
    const states = [];
    const skipped = [];
    if (!result.emotions || result.emotions.length === 0) {
      return { applied, states, skipped, empty: true };
    }

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
      const weights = Emotions.adjustCloseOnly(rawWeights, closeOnly, about === 'user');

      const cap = await emotions.capFor(key);
      const score = herEmotion.intensity * cap;
      // 2026-11-25 用户要求：入账门槛 0.15 → 0.10（judge.js 的过滤同步改）。
      if (score < 0.1 * cap) {
        skipped.push({ key, intensity: herEmotion.intensity, score, reason: `低于入账门槛 ${0.1 * cap}` });
        continue;
      }

      const deltas = MoodPool.calculateWeighted(weights, score, cap);
      if (deltas.length === 0) {
        skipped.push({ key, intensity: herEmotion.intensity, score, reason: '权重算不出任何变化' });
        continue;
      }

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
        states.push({ key, name: stateDef.name, minutes: stateDef.minutes || 60 });
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
      applied.push({
        key,
        label,
        score,
        deltas: adjusted.map(d => ({ base: d.base, delta: d.delta })),
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

    return { applied, states, skipped };
  }

  // --- session/event wiring (post-commit feed, qq-bridge pattern) ---
  // Every ctx.on returns a disposer; collect them so a fiber reload removes
  // ALL listeners (a leaked listener = double judging / stale handlers).
  const offSessionEvent = ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id;
      if (!sessionId || !event || typeof event.type !== 'string') return;
      // 只认她的会话（targetWorkspaceDir 按目录自动认家，其次 targetSessionId）：
      // 其他的（工作会话、工具会话）不进她的情绪账。
      if (!isTargetSession(sessionId)) return;
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
        // 先算无聊的轮次账（B 只可能在这一步触发），再进异步判句。
        settleBoredomTurn(sessionId, now);
        fireAndForget(onTurnEnd(sessionId, now));
        return;
      }
    } catch (e) {
      ctx.logger?.warn?.('[dsh-mood-changes] session/event error:', e);
    }
  });

  // Per-session maps must not leak after a session leaves the registry.
  const offSessionDisposed = ctx.on('session/disposed', (session) => {
    turnUserTexts.delete(session?.id);
    pendingReplies.delete(session?.id);
    qqSends.delete(session?.id);
    turnHasWork.delete(session?.id);
    aTurn.delete(session?.id);
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
      ctx.logger?.warn?.('[dsh-mood-changes] tick error:', e);
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
    toolDisposers = registerTools(ctx, store, baselineRef, () => state, saveNow, settleQueueNow, () => tuning);
  } catch (e) {
    ctx.logger?.warn?.('[dsh-mood-changes] tool registration error:', e);
  }

  // --- Register HTTP routes ---
  let routeDisposers = [];
  try {
    routeDisposers = registerRoutes(ctx, store, baselineRef, () => state, tick, () => tuning);
  } catch (e) {
    ctx.logger?.warn?.('[dsh-mood-changes] route registration error:', e);
  }

  // --- Settings page API (E19) ---
  // 客户端 settings.plugins.tab 的配置页由插件自己注册；这一层供设置页读写
  // 插件配置（profile）、运行参数（tuning.json，即时生效）和情绪基线（baseline.json）。
  try {
    routeDisposers.push(...registerSettingsRoutes(ctx, {
      config,
      worldDir,
      store,
      getTuning: () => tuning,
      setTuning: (next) => { tuning = next; },
    }));
  } catch (e) {
    ctx.logger?.warn?.('[dsh-mood-changes] settings API registration error:', e);
  }

  // --- Tools/result → boredom drop + qq_bridge_send 截给判官 ---
  // 会话归属判定（用户 2026-11-23）：思念/无聊的降值只认她的会话——别的会话
  // （比如工作会话）调工具不再降她的无聊。tools/result 是 Scoped<ToolsService>
  // 事件，this 绑定发起 agent 的 scope；多路径提取 sessionId，取不到时维持
  // 旧行为（降），取到且不是她的会话则跳过。
  const offToolsResult = ctx.on('tools/result', function (exec) {
    if (!state) return;
    let sessionId = null;
    try {
      const scoped = this;
      if (scoped?.scope?.session?.id) sessionId = scoped.scope.session.id;
      else if (scoped?.session?.id) sessionId = scoped.session.id;
      else if (exec?.agent?.session?.id) sessionId = exec.agent.session.id;
      else if (exec?.agent?.id) sessionId = exec.agent.id;
      else if (exec?.sessionId) sessionId = exec.sessionId;
    } catch {}
    if (hasSessionRestriction() && sessionId) {
      const target = targetSessionId();
      if (!target || String(sessionId) !== target) return;
    }
    const now = Date.now();
    // E25（2026-11-25 用户要求）：她这一轮用 qq_bridge_send 发去 QQ 的话，
    // 也截下来在 turn/end 喂判官 —— 工具调用不进 assistant/message，否则
    // 判官只看到她「没说话」。
    const sentText = qqSendTextOf(exec);
    if (sentText && sessionId) {
      const list = qqSends.get(sessionId) || [];
      list.push({ ts: now, text: sentText });
      if (list.length > 5) list.splice(0, list.length - 5);
      qqSends.set(sessionId, list);
    }
    // E30（2026-11-25 用户拍板）：工具侧衰减仍是「做一件事 ×0.6」，但它只是
    // A —— 落地即开轮次窗口（A 那轮 = 第 0 轮），不再按调用次数往 5 数。
    // 计数用的「本轮调过工具」在这里记；B 在 turn/end 才结算。
    // 计数口径（2026-11-25 用户补充）：本轮要调过 qq_bridge_send **以外**的
    // 工具才算「干过活」——她在 QQ 上纯发消息不算干活，那一轮不推进计数。
    if (sessionId && exec?.name !== 'qq_bridge_send') turnHasWork.set(sessionId, true);
    const first = Boredom.drop(state.boredom, now, 'tool', tuning);
    if (first > 0) {
      Boredom.startCountWindow(state.boredom, now);
      if (sessionId) aTurn.set(sessionId, true);
      fireAndForget(log.append({
        ts: now, block: '无聊', emotion: '无聊',
        delta: -Math.round(first * 10) / 10,
        reason: `做了件事（${exec.name}）×0.6`
      }));
      stateDirty = true;
      saveStateIfDirty(now).catch(() => {});
    }
  });

  // --- Init ---
  init().then(() => {
    ctx.logger?.info?.('[dsh-mood-changes] Initialized with worldDir:', worldDir);
  }).catch(e => {
    ctx.logger?.warn?.('[dsh-mood-changes] init error:', e);
  });

  // --- Cleanup ---
  // Remove EVERYTHING this fiber registered: leaked listeners would double-
  // judge turns and stale route handlers would keep answering with stale
  // state after a reload.
  return () => {
    tickInterval();
    for (const d of toolDisposers) d();
    for (const d of routeDisposers) { try { d(); } catch {} }
    if (typeof offMoodContext === 'function') { try { offMoodContext(); } catch {} }
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
