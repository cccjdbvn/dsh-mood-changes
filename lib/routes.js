import { MoodPool } from './pool.js';
import { MoodLog } from './log.js';

const BASE_LABELS = { happy: '开心', sad: '伤心', fear: '害怕', anger: '生气', surprise: '惊讶', disgust: '厌恶' };

const INITIAL = {
  values: { happy: 15, sad: 5, fear: 5, anger: 0, surprise: 0, disgust: 5 },
  top2: [
    { base: 'happy', label: '开心', value: 15 },
    { base: 'sad', label: '伤心', value: 5 }
  ],
  dominant: { base: 'calm', label: '平静', value: 0 },
  states: [],
  missing: { value: 0 },
  boredom: { value: 0 },
  lastTickAt: 0,
  lastInjectAt: 0,
  initializing: true
};

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

/**
 * Register HTTP routes for the mood panel.
 * Serves read-only data for the client pill and card.
 * Returns disposers so a fiber reload can unregister its routes (otherwise
 * stale handlers keep answering with stale state).
 */
export function registerRoutes(ctx, store, baselineRef, getState, onTick) {
  const webServer = ctx.get('webServer');
  // 她修胶囊时踩出的教训（2026-11-23）：webServer 未就绪时绝不能静默返回——
  // 面板会拿不到数据且无任何线索。必须喊出来。
  if (!webServer) {
    ctx.logger?.warn?.('[dsh-mood-changes] webServer not ready; panel routes NOT registered');
    return [];
  }

  const disposers = [];

  // GET /dsh-mood-changes/state — current values, states, missing, boredom, baseline
  const dState = webServer.register({
    kind: 'exact',
    path: '/dsh-mood-changes/state',
    resource: async (_req) => {
      const state = getState();
      // C1: before init() completes, serve a placeholder instead of throwing.
      if (!state) return jsonResponse(INITIAL);

      const top2 = MoodPool.top2(state.values);
      const activeStates = (state.states || []).filter(s => s.until > Date.now());

      return jsonResponse({
        values: state.values,
        top2: top2.map(t => ({ base: t.base, label: BASE_LABELS[t.base], value: Math.round(t.value * 10) / 10 })),
        dominant: top2[0].value < 20 ? { base: 'calm', label: '平静', value: 0 }
                  : { base: top2[0].base, label: BASE_LABELS[top2[0].base], value: Math.round(top2[0].value * 10) / 10 },
        states: activeStates.map(s => ({ name: s.name, until: s.until, from: s.from })),
        missing: { value: Math.round((state.missing?.value || 0) * 10) / 10 },
        boredom: { value: Math.round((state.boredom?.value || 0) * 10) / 10 },
        // Baseline marks for the card's bars (read from the single source of
        // truth so mood_baseline tool changes show up on the next poll).
        baseline: baselineRef?.current || {},
        lastTickAt: state.lastTickAt || 0,
        lastInjectAt: state.lastInjectAt || 0
      });
    }
  });
  if (typeof dState === 'function') disposers.push(dState);

  // GET /dsh-mood-changes/log?date=YYYY-MM-DD&block=乐
  const dLog = webServer.register({
    kind: 'exact',
    path: '/dsh-mood-changes/log',
    resource: async (req) => {
      // Parse query string manually to avoid URL constructor issues with relative URLs
      const qs = (req.url || '').split('?')[1] || '';
      const params = new URLSearchParams(qs);
      const date = params.get('date') || MoodLog.dateFor(Date.now());
      const block = params.get('block') || null;

      const moodLog = new MoodLog(store.worldDir);
      const entries = await moodLog.read(date, block);

      // 面板显示层（2026-11-24 用户需求）：变化列显示「怒+5」「无聊-12」
      // 这样的块名+带符号数值。只在响应里加一个 change 字段，日志 .md
      // 仍然是纯数值，回滚解析 delta 的口径不动。
      return jsonResponse({
        date,
        entries: entries.map(e => ({ ...e, change: MoodLog.changeText(e) })),
      });
    }
  });
  if (typeof dLog === 'function') disposers.push(dLog);

  // GET /dsh-mood-changes/tick — 立刻核算一次（2026-11-24 添）。
  // 定时核算 15 分钟一次，调试时要干等到下一次才知道它有没有抛错；这一条省掉等待。
  // 用 GET 是因为 resource 路由只接 GET/HEAD；本机、只读账，够用。
  if (typeof onTick === 'function') {
    const dTick = webServer.register({
      kind: 'exact',
      path: '/dsh-mood-changes/tick',
      resource: async (_req) => {
        try {
          await onTick(Date.now());
          const state = getState();
          return jsonResponse({
            ok: true,
            lastTickAt: state?.lastTickAt || 0,
            values: state?.values || {},
            queue: (state?.queue || []).length
          });
        } catch (error) {
          return jsonResponse({ ok: false, error: String(error?.stack || error) });
        }
      }
    });
    if (typeof dTick === 'function') disposers.push(dTick);
  }

  return disposers;
}