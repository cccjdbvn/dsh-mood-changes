import { MoodPool } from './pool.js';
import { MoodLog } from './log.js';

const BASE_LABELS = { happy: '乐', sad: '悲', fear: '惧', anger: '怒', surprise: '惊', disgust: '厌' };

/**
 * Register HTTP routes for the mood panel.
 * Serves read-only data for the client pill and card.
 */
export function registerRoutes(ctx, store, getState) {
  const webServer = ctx.get('webServer');
  if (!webServer) return;

  // GET /api/mood/state — current values, states, missing, boredom
  webServer.register({
    kind: 'exact',
    path: '/api/mood/state',
    resource: async (_req) => {
      const state = getState();
      const top2 = MoodPool.top2(state.values);
      const activeStates = (state.states || []).filter(s => s.until > Date.now());

      return new Response(JSON.stringify({
        values: state.values,
        top2: top2.map(t => ({ base: t.base, label: BASE_LABELS[t.base], value: t.value })),
        dominant: top2[0].value < 20 ? { base: 'calm', label: '平静', value: 0 } 
                  : { base: top2[0].base, label: BASE_LABELS[top2[0].base], value: top2[0].value },
        states: activeStates.map(s => ({ name: s.name, until: s.until, from: s.from })),
        missing: { value: state.missing?.value || 0 },
        boredom: { value: state.boredom?.value || 0 },
        lastTickAt: state.lastTickAt || 0,
        lastInjectAt: state.lastInjectAt || 0
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  });

  // GET /api/mood/log?date=YYYY-MM-DD&block=乐
  webServer.register({
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

      return new Response(JSON.stringify({ date, entries }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  });
}