import { MoodPool } from './pool.js';
import { MoodLog } from './log.js';

const BASE_LABELS = { happy: '乐', sad: '悲', fear: '惧', anger: '怒', surprise: '惊', disgust: '厌' };

const INITIAL = {
  values: { happy: 15, sad: 5, fear: 5, anger: 0, surprise: 0, disgust: 5 },
  top2: [
    { base: 'happy', label: '乐', value: 15 },
    { base: 'sad', label: '悲', value: 5 }
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
export function registerRoutes(ctx, store, baselineRef, getState) {
  const webServer = ctx.get('webServer');
  if (!webServer) return [];

  const disposers = [];

  // GET /api/mood/state — current values, states, missing, boredom, baseline
  const dState = webServer.register({
    kind: 'exact',
    path: '/api/mood/state',
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

  // GET /api/mood/log?date=YYYY-MM-DD&block=乐
  const dLog = webServer.register({
    kind: 'exact',
    path: '/api/mood/log',
    resource: async (req) => {
      // Parse query string manually to avoid URL constructor issues with relative URLs
      const qs = (req.url || '').split('?')[1] || '';
      const params = new URLSearchParams(qs);
      const date = params.get('date') || MoodLog.dateFor(Date.now());
      const block = params.get('block') || null;

      const moodLog = new MoodLog(store.worldDir);
      const entries = await moodLog.read(date, block);

      return jsonResponse({ date, entries });
    }
  });
  if (typeof dLog === 'function') disposers.push(dLog);

  return disposers;
}