import { MoodLog } from './log.js';
import { HALF_LIVES_MS } from './pool.js';

const BASES = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust'];
const SIX_BLOCKS = new Set(['乐', '悲', '怒', '惧', '惊', '厌']);

/**
 * Register the three model-facing tools: mood_log, mood_rollback, mood_baseline.
 */
export function registerTools(ctx, store, baselineRef, getState, saveNow) {
  const tools = ctx.get('tools');
  if (!tools) return [];

  const disposers = [];

  // mood_log — query log entries
  disposers.push(tools.register({
    name: 'mood_log',
    description: '查询指定日期的情绪日志，可按情绪块筛选。返回条目含两个时间：time=记录时间（判句时刻），effective=生效时间（衰减起点）。六情条目的变化列是最终生效值（受状态修饰时括注原值）。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期，YYYY-MM-DD 格式；不填默认今天' },
        block: { type: 'string', description: '情绪块筛选：乐/悲/怒/惧/惊/厌/思念/无聊/状态；不填返回全部', enum: ['乐', '悲', '怒', '惧', '惊', '厌', '思念', '无聊', '状态'] }
      },
      required: []
    },
    output: {
      schema: { type: 'object', properties: { date: { type: 'string' }, entries: { type: 'array' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    async execute(args) {
      const moodLog = new MoodLog(store.worldDir);
      const date = args.date || MoodLog.dateFor(Date.now());
      const entries = await moodLog.read(date, args.block || null);
      return { date, entries };
    }
  }));

  // mood_rollback — A7 numeric rollback (same-day only) + E2 state rollback
  disposers.push(tools.register({
    name: 'mood_rollback',
    description: `回滚当日情绪日志的某条记录——账面划线 AND 数值修正：按那笔的生效时间（衰减起点）重放半衰期，把它还剩下的影响从当前值里扣掉（新值不为 0 时同时入账新值），并连带撤销同一时刻由它传播出去的子条。只能回滚今天（按 04:00 切天）的记录。block=状态 时回滚状态触发行：从当前生效状态里清除该状态（今天还有更早的未划线触发时，回退到那次的时效而不是删除）。纯删除（不填 newDelta）且该判句的所有主条都已划线时，会连带撤销它触发的状态；改值回滚（newDelta≠0）不撤状态。`,
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: '要回滚那条的「时间」列（记录时间），HH:MM，如 14:23' },
        block: { type: 'string', description: '那条所在的块：乐/悲/怒/惧/惊/厌/思念/无聊/状态', enum: ['乐', '悲', '怒', '惧', '惊', '厌', '思念', '无聊', '状态'] },
        newDelta: { type: 'number', description: '替换成的新值（正负均可）；不填或 0 = 纯删除该笔' },
        note: { type: 'string', description: '回滚原因（写在账上，≤70 字）' }
      },
      required: ['time', 'block']
    },
    output: {
      schema: { type: 'object', properties: { success: { type: 'boolean' }, reason: { type: 'string' }, detail: { type: 'object' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    async execute(args) {
      const state = getState();
      if (!state) return { success: false, reason: '状态还没加载' };

      const today = MoodLog.dateFor(Date.now());
      const moodLog = new MoodLog(store.worldDir);

      // 1. Ledger: strike the row (+ cascaded propagation rows), get entries.
      const result = await moodLog.rollback(today, args.time, args.block, {
        note: args.note || '',
        newDelta: args.newDelta ?? 0
      });
      if (!result.success) return result;

      const now = Date.now();
      const detail = { removed: [], cascades: 0, corrections: [] };

      // ── E2 state rollback: strike the trigger row, clear/revert the live state.
      // States persist independently of the numeric ledger (trigger rows are
      // written at judge time), so rolling back the emotion that caused a
      // state never removed it — this branch is the explicit undo.
      if (args.block === '状态') {
        const main = result.entries[0];
        const stateName = String(main.emotion || '').trim();
        if (!stateName || stateName === '回滚') {
          return { success: false, reason: '那条不是状态触发行（情绪列应为状态名）' };
        }
        detail.removed.push(`${main.time} ${stateName}（触发 ${main.effective}）`);
        detail.state = await settleStateAfterRollback(state, moodLog, today, stateName, now);

        if (typeof saveNow === 'function') await saveNow();
        else await store.saveState(state);

        return {
          success: true,
          reason: `已回滚 ${detail.removed.join('；')}，${detail.state}`,
          detail
        };
      }

      // 2. Numeric replay, entry by entry.
      for (const e of result.entries) {
        const base = MoodLog.baseForBlock(e.block);
        const effTs = effectiveTimestamp(today, e.effective);
        const dtMs = Math.max(0, now - effTs);
        // 无聊/思念没有半衰期：影响不衰减，剩余 = 原值。
        const halfMs = base ? HALF_LIVES_MS[base] : null;
        const decay = halfMs ? Math.pow(0.5, dtMs / halfMs) : 1;
        const remaining = e.delta * decay;

        const target = base || (e.block === '无聊' ? 'boredom' : e.block === '思念' ? 'missing' : null);
        if (!target) continue;

        if (base) {
          const before = state.values[base] ?? 0;
          state.values[base] = Math.max(0, before - remaining);
          detail.corrections.push(`${e.block}：扣剩余 ${remaining.toFixed(1)}（原 ${e.delta}，衰减×${decay.toFixed(3)}）`);
        } else {
          const holder = target === 'boredom' ? state.boredom : state.missing;
          const before = holder.value ?? 0;
          holder.value = Math.max(0, before - remaining);
          detail.corrections.push(`${e.block}：扣 ${remaining.toFixed(1)}（不衰减）`);
        }

        if (e === result.entries[0]) {
          detail.removed.push(`${e.time} ${e.emotion} ${e.delta >= 0 ? '+' : ''}${e.delta}（生效 ${e.effective}）`);
        } else {
          detail.cascades += 1;
        }
      }

      // 3. New delta lands now (fresh deposit, no decay yet).
      const newDelta = args.newDelta ?? 0;
      if (newDelta !== 0) {
        const base = MoodLog.baseForBlock(args.block);
        if (base) {
          state.values[base] = Math.max(0, Math.min(100, (state.values[base] ?? 0) + newDelta));
        } else if (args.block === '无聊') {
          state.boredom.value = Math.max(0, (state.boredom.value ?? 0) + newDelta);
        } else if (args.block === '思念') {
          state.missing.value = Math.max(0, Math.min(100, (state.missing.value ?? 0) + newDelta));
        }
        detail.corrections.push(`新值入账 ${newDelta >= 0 ? '+' : ''}${newDelta}`);
      }

      // 3.5 E3 cascade: a PURE DELETION (newDelta 0/absent) that strikes the
      // last standing main row of a verdict also undoes the state that same
      // verdict triggered (trigger row shares the record time, reason is
      // 触发：<label>). A value correction (newDelta ≠ 0) keeps the state —
      // the verdict still stands, just re-sized. Partial rollback (another
      // base row of the verdict still standing) also keeps the state.
      if (!newDelta && SIX_BLOCKS.has(args.block)) {
        const mainRow = result.entries[0];
        const label = String(mainRow.emotion || '').trim().split(/\s+/)[0];
        const stillStanding = (await moodLog.read(today)).some(r =>
          SIX_BLOCKS.has(r.block) && r.time === mainRow.time && r.reason === mainRow.reason);
        if (label && !stillStanding) {
          const trig = (await moodLog.read(today, '状态')).find(r =>
            r.time === mainRow.time && String(r.reason) === `触发：${label}`);
          if (trig && String(trig.emotion) !== '回滚') {
            const rState = await moodLog.rollback(today, trig.time, '状态', {
              note: `连带：${label} 判句已整体回滚`
            });
            if (rState.success) {
              detail.state = await settleStateAfterRollback(state, moodLog, today, String(trig.emotion), now);
              detail.removed.push(`${trig.time} ${trig.emotion}（连带撤）`);
            }
          }
        }
      }

      // 4. Persist immediately (rollback must not wait for the throttle).
      if (typeof saveNow === 'function') await saveNow();
      else await store.saveState(state);

      return {
        success: true,
        reason: `已回滚 ${detail.removed.join('；')}${detail.cascades > 0 ? `，连带撤 ${detail.cascades} 笔传播` : ''}${detail.state ? `，${detail.state}` : ''}`,
        detail
      };
    }
  }));

  // mood_baseline — write baseline.json
  // The file watcher in index.js picks the change up and runs the sync
  // (values below the new baseline are lifted, values above stay).
  disposers.push(tools.register({
    name: 'mood_baseline',
    description: '写入六情基线值（她的正常状态）。写完后插件自动同步：当前值不足基线的补齐到基线，超过基线的不变（保留她当下更高的情绪），之后的衰减向新基线回归。六条值范围 0–100。',
    parameters: {
      type: 'object',
      properties: {
        happy: { type: 'number', description: '乐基线' },
        sad: { type: 'number', description: '悲基线' },
        fear: { type: 'number', description: '惧基线' },
        anger: { type: 'number', description: '怒基线' },
        surprise: { type: 'number', description: '惊基线' },
        disgust: { type: 'number', description: '厌基线' }
      },
      required: []
    },
    output: {
      schema: { type: 'object', properties: { success: { type: 'boolean' }, baseline: { type: 'object' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    async execute(args) {
      const current = { ...baselineRef.current };
      for (const base of BASES) {
        if (typeof args[base] === 'number') {
          current[base] = Math.max(0, Math.min(100, args[base]));
        }
      }
      await store.saveBaseline(current);
      baselineRef.current = current;
      // No numeric sync here: the baseline-file watcher in index.js reacts to
      // the write and applies "lift-below, keep-above" once, for every
      // change source (tool, hand edit, anything).
      return { success: true, baseline: current };
    }
  }));

  return disposers;
}

/**
 * Shared state fix after a trigger row is struck (E2 explicit rollback and
 * E3 verdict cascade alike): re-derive the live state from the remaining
 * (un-struck) trigger rows today. read() skips struck rows, so "remaining"
 * is exactly the live triggers. Refresh semantics: until = latest remaining
 * trigger + its own duration. Returns a human message for the log/detail.
 */
async function settleStateAfterRollback(state, moodLog, today, stateName, now) {
  if (!Array.isArray(state.states)) state.states = [];
  const remaining = (await moodLog.read(today, '状态'))
    .filter(r => r.emotion === stateName && String(r.reason || '').startsWith('触发'));

  let until = 0;
  for (const t of remaining) {
    const m = String(t.state || '').match(/(\d+)\s*min/);
    const minutes = m ? Number(m[1]) : 60;
    until = Math.max(until, effectiveTimestamp(today, t.time) + minutes * 60000);
  }

  const idx = state.states.findIndex(s => s.name === stateName);
  if (remaining.length === 0) {
    if (idx >= 0) state.states.splice(idx, 1);
    return `状态「${stateName}」已从当前生效中清除`;
  }
  if (until <= now) {
    if (idx >= 0) state.states.splice(idx, 1);
    return `状态「${stateName}」剩余触发也已过期，直接清除`;
  }
  if (idx < 0) return `状态「${stateName}」当前不在生效中（剩余触发截至 ${fmtTime(until)}）`;
  state.states[idx].until = until;
  return `状态「${stateName}」回退到剩余触发的时效（至 ${fmtTime(until)}）`;
}

/** "HH:MM" + file date → timestamp (the file date already accounts for the
 *  04:00 cutoff, so HH:MM maps onto that local date directly). */
function effectiveTimestamp(fileDate, hhmmStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmmStr || '').trim());
  if (!m) return 0;
  const [y, mo, d] = fileDate.split('-').map(Number);
  return new Date(y, mo - 1, d, Number(m[1]), Number(m[2])).getTime();
}

/** Local HH:MM for a timestamp (E2 state-rollback detail messages). */
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}