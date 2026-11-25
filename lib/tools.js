import { MoodLog } from './log.js';
import { HALF_LIVES_MS } from './pool.js';

const BASES = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust'];
const SIX_BLOCKS = new Set(['乐', '悲', '怒', '惧', '惊', '厌']);

/**
 * Register the model-facing tools: mood_log, mood_settle, mood_rollback, mood_baseline.
 */
export function registerTools(ctx, store, baselineRef, getState, saveNow, settleNow, getTuning) {
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

  // mood_settle — 主动核算（2026-11-24 用户需求）：
  //   由模型主动启动，无冷却；只结算「上次结算以来」队列里的判句事件
  //   （delta + 耦合传播 + 写日志 + 落盘），**不衰减、不推进 tick、
  //   不跑思念/无聊、不掷骰、不注入**。想撤某笔就先核算、再回滚。
  if (typeof settleNow === 'function') {
    disposers.push(tools.register({
      name: 'mood_settle',
      description: '主动核算：立刻把上次结算以来积在队列里的判句事件真正入账（delta + 耦合传播 + 写日志 + 立即落盘）。不做时间衰减、不推进 tick（lastTickAt 不动）、不跑思念/无聊、不掷骰、不注入；无冷却，可连续调用。队列为空时返回 settled:0。想撤某笔误判就先核算、再用 mood_rollback 回滚。',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            settled: { type: 'number' },
            reason: { type: 'string' },
            rows: { type: 'array' },
            changes: { type: 'object' },
            values: { type: 'object' }
          }
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
      async execute() {
        const state = getState();
        if (!state) return { success: false, reason: '状态还没加载' };
        let result;
        try {
          result = settleNow(Date.now());
        } catch (e) {
          return { success: false, reason: `核算出错：${e?.message || e}` };
        }
        if (!result) return { success: false, reason: '核算没有返回结果' };
        if (result.queued === 0) {
          return {
            success: true,
            settled: 0,
            reason: '队列里没有待结算的事件',
            values: result.values
          };
        }
        if (typeof saveNow === 'function') await saveNow();
        else await store.saveState(state);
        return {
          success: true,
          settled: result.queued,
          rows: result.rows.map(r => ({
            block: r.block,
            emotion: r.emotion,
            delta: r.delta,
            reason: r.reason
          })),
          changes: result.changes,
          values: result.values
        };
      }
    }));
  }

  // mood_rollback — A7 numeric rollback (same-day only) + E2 state rollback
  //   + E3 verdict cascade + E7 batch (range sweep / explicit list)
  disposers.push(tools.register({
    name: 'mood_rollback',
    description: `回滚当日情绪日志（按 04:00 切天）。三种直接用法：①单笔：time+block（可带 newDelta 改值，不填=纯删除）——账面划线 + 按生效时间重放半衰期修正数值 + 连带撤同刻传播子条；block=状态 时回滚状态触发行（清除该状态，有更早触发则回退时效）。②范围清扫：from+to（HH:MM，含端点）——范围内所有站着的判句主条（六情块）全部纯删除，各自带传播级联和状态级联；思念/无聊/状态行和范围外的判句不动。③列表批量：items=[{time,block},…]——只撤列出的，纯删除。④标记机制：先把误判条目 mark（单条 {time,block} 或列表，标记持久保存），攒着；executeMarked: true 一键执行全部已标记（纯删除）；unmark 解除；不带任何参数调用会列出当前已标记的条目。纯删除且判句主条全划线时会连带撤销它触发的状态；改值回滚（newDelta≠0）不撤状态。批量/标记模式不支持 newDelta。回滚无冷却，可连续调用。`,
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: '单笔模式：要回滚那条的「时间」列（记录时间），HH:MM，如 14:23（与 block 搭配）' },
        block: { type: 'string', description: '单笔模式：那条所在的块：乐/悲/怒/惧/惊/厌/思念/无聊/状态', enum: ['乐', '悲', '怒', '惧', '惊', '厌', '思念', '无聊', '状态'] },
        from: { type: 'string', description: '范围清扫模式：起点 HH:MM（含），与 to 搭配；扫掉范围内所有站着的判句主条（六情块，纯删除）' },
        to: { type: 'string', description: '范围清扫模式：终点 HH:MM（含），与 from 搭配' },
        items: { type: 'array', description: '列表批量模式：[{time:"HH:MM", block:"怒"}, …]；只撤列出的，纯删除', items: { type: 'object', properties: { time: { type: 'string' }, block: { type: 'string' } }, required: ['time', 'block'] } },
        mark: { description: '标记模式：把误判条目标记为待回滚（单条 {time,block} 或列表）。只做标记不动数值；之后用 executeMarked 一键执行', items: { type: 'object', properties: { time: { type: 'string' }, block: { type: 'string' } }, required: ['time', 'block'] } },
        unmark: { description: '解除标记：{time,block} 或列表', items: { type: 'object', properties: { time: { type: 'string' }, block: { type: 'string' } }, required: ['time', 'block'] } },
        executeMarked: { type: 'boolean', description: '执行全部已标记的条目（纯删除，逐笔带传播级联和状态级联）；标记后已被单独回滚的视为完成' },
        newDelta: { type: 'number', description: '单笔模式：替换成的新值（正负均可）；不填或 0 = 纯删除该笔（批量/标记模式不支持）' },
        note: { type: 'string', description: '回滚原因（写在账上，≤70 字；批量/执行标记时每笔共用）' }
      },
      required: []
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
      const now = Date.now();

      // ── Core: roll back ONE row. Ledger strike (with propagation cascade)
      // + E2 state branch + numeric replay + E3 state cascade. Does NOT
      // persist — the caller saves once after single/batch. ──
      async function rollbackOne(time, block, note, newDelta) {
        newDelta = newDelta ?? 0; // pure deletion when absent (guard: undefined !== 0)
        // 1. Ledger: strike the row (+ cascaded propagation rows), get entries.
        const result = await moodLog.rollback(today, time, block, {
          note: note || '',
          newDelta: newDelta ?? 0
        });
        if (!result.success) return result;

        const detail = { removed: [], cascades: 0, corrections: [] };

        // ── E2 state rollback: strike the trigger row, clear/revert the live
        // state. States persist independently of the numeric ledger (trigger
        // rows are written at judge time), so rolling back the emotion that
        // caused a state never removed it — this branch is the explicit undo.
        if (block === '状态') {
          const main = result.entries[0];
          const stateName = String(main.emotion || '').trim();
          if (!stateName || stateName === '回滚') {
            return { success: false, reason: '那条不是状态触发行（情绪列应为状态名）' };
          }
          detail.removed.push(`${main.time} ${stateName}（触发 ${main.effective}）`);
          detail.state = await settleStateAfterRollback(state, moodLog, today, stateName, now);
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
          // 六情半衰期读 tuning（设置页可调），没配时用默认常量。
          const halfMs = base
            ? (getTuning?.()?.mood?.[`${base}HalfLifeMs`] ?? HALF_LIVES_MS[base])
            : null;
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
        if (newDelta !== 0) {
          const base = MoodLog.baseForBlock(block);
          if (base) {
            state.values[base] = Math.max(0, Math.min(100, (state.values[base] ?? 0) + newDelta));
          } else if (block === '无聊') {
            state.boredom.value = Math.max(0, (state.boredom.value ?? 0) + newDelta);
          } else if (block === '思念') {
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
        if (!newDelta && SIX_BLOCKS.has(block)) {
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

        return {
          success: true,
          reason: `已回滚 ${detail.removed.join('；')}${detail.cascades > 0 ? `，连带撤 ${detail.cascades} 笔传播` : ''}${detail.state ? `，${detail.state}` : ''}`,
          detail
        };
      }

      // ── Mode dispatch (E7): time+block single / from+to sweep / items list
      //   / mark+unmark+executeMarked (E7b 显式标记机制，用户 2026-11-24 拍板). ──
      if (!Array.isArray(state.pendingRollback)) state.pendingRollback = [];
      const hasSingle = Boolean(args.time || args.block);
      const hasRange = Boolean(args.from || args.to);
      const hasItems = Array.isArray(args.items);
      const hasMark = args.mark !== undefined && args.mark !== null;
      const hasUnmark = args.unmark !== undefined && args.unmark !== null;
      const hasExecute = args.executeMarked === true;
      const modeCount = [hasSingle, hasRange, hasItems, hasMark, hasUnmark, hasExecute].filter(Boolean).length;
      if (modeCount === 0) {
        // 无参数：返回当前标记清单（没标记时才报用法错误）。
        if (state.pendingRollback.length > 0) {
          return {
            success: true,
            reason: `当前有 ${state.pendingRollback.length} 条标记待回滚（executeMarked: true 一键执行；unmark 解除）`,
            detail: { pending: state.pendingRollback }
          };
        }
        return { success: false, reason: '请指定回滚目标：time+block（单笔）、from+to（范围清扫）、items（列表批量）、mark（标记待回滚）、unmark（解除标记）、executeMarked（执行已标记）——六选一' };
      }
      if (modeCount > 1) return { success: false, reason: '模式互斥：time+block / from+to / items / mark / unmark / executeMarked 只能给一种' };
      if (hasSingle && !(args.time && args.block)) return { success: false, reason: '单笔回滚需要 time 和 block 一起给' };
      if (hasRange && !(args.from && args.to)) return { success: false, reason: '范围清扫需要 from 和 to 一起给（HH:MM）' };

      const persist = async () => {
        if (typeof saveNow === 'function') await saveNow();
        else await store.saveState(state);
      };

      // ⑤ mark — 把误判条目标记为待回滚（只记账上标记，不动数值不动日志）。
      if (hasMark) {
        const list = Array.isArray(args.mark) ? args.mark : [args.mark];
        if (list.length === 0) return { success: false, reason: 'mark 为空' };
        const bad = list.find(it => !it || !it.time || !it.block);
        if (bad) return { success: false, reason: 'mark 里每条都要有 time 和 block' };
        const rows = await moodLog.read(today);
        for (const it of list) {
          const time = String(it.time), block = String(it.block);
          if (state.pendingRollback.some(p => p.time === time && p.block === block)) continue; // dedupe
          const row = rows.find(r => r.time === time && r.block === block && r.emotion !== '回滚' && r.emotion !== '传播');
          if (!row) return { success: false, reason: `没有可标记的行：${block} ${time}（不存在/已划线/替换行/传播行不算）` };
          state.pendingRollback.push({ time, block, emotion: row.emotion, reason: row.reason, markedAt: now });
        }
        await persist();
        return {
          success: true,
          reason: `已标记，当前共 ${state.pendingRollback.length} 条待回滚`,
          detail: { pending: state.pendingRollback }
        };
      }

      // ⑥ unmark — 解除标记。
      if (hasUnmark) {
        const list = Array.isArray(args.unmark) ? args.unmark : [args.unmark];
        const before = state.pendingRollback.length;
        for (const it of list) {
          const time = String(it?.time ?? ''), block = String(it?.block ?? '');
          state.pendingRollback = state.pendingRollback.filter(p => !(p.time === time && p.block === block));
        }
        await persist();
        return {
          success: true,
          reason: `已解除 ${before - state.pendingRollback.length} 条标记，剩 ${state.pendingRollback.length} 条`,
          detail: { pending: state.pendingRollback }
        };
      }

      // ⑦ executeMarked — 一键执行全部已标记（纯删除，走 rollbackOne 核心）。
      // 标记后已被单独回滚的条目视为完成（从标记里移除），不再留在队列。
      if (hasExecute) {
        const pending = [...state.pendingRollback];
        if (pending.length === 0) return { success: false, reason: '当前没有标记待回滚的条目（先用 mark 标记）' };
        const done = [];
        const stillPending = [];
        for (const p of pending) {
          const r = await rollbackOne(p.time, p.block, args.note, 0);
          if (r.success) {
            done.push({ time: p.time, block: p.block, emotion: p.emotion, reason: r.reason });
          } else if (/可回滚行/.test(r.reason || '')) {
            done.push({ time: p.time, block: p.block, emotion: p.emotion, reason: '标记后已被单独回滚，视为完成' });
          } else {
            stillPending.push({ ...p, failReason: r.reason });
          }
        }
        state.pendingRollback = stillPending;
        if (done.length === 0) {
          return { success: false, reason: `标记的 ${pending.length} 条全部执行失败（第一条：${stillPending[0]?.time} ${stillPending[0]?.block}：${stillPending[0]?.failReason}）`, detail: { stillPending } };
        }
        await persist();
        return {
          success: true,
          reason: `执行标记回滚 ${done.length}/${pending.length} 条：${done.map(x => `${x.time} ${x.block} ${x.emotion}`).join('；')}`,
          detail: { count: done.length, total: pending.length, results: done, stillPending }
        };
      }

      // ① Single (supports newDelta).
      if (hasSingle) {
        const r = await rollbackOne(String(args.time), String(args.block), args.note, args.newDelta);
        if (r.success) await persist();
        return r;
      }

      // ② Items list — pure deletions of exactly the listed rows.
      if (hasItems) {
        if (args.items.length === 0) return { success: false, reason: 'items 列表为空' };
        const bad = args.items.find(it => !it || !it.time || !it.block);
        if (bad) return { success: false, reason: 'items 里每条都要有 time 和 block' };
        const results = [];
        for (const it of args.items) {
          const r = await rollbackOne(String(it.time), String(it.block), args.note, 0);
          results.push({ time: it.time, block: it.block, success: r.success, reason: r.reason, detail: r.detail });
        }
        const okCount = results.filter(x => x.success).length;
        if (okCount === 0) {
          return { success: false, reason: `列表 ${results.length} 条全部失败（第一条：${results[0].reason}）`, detail: { count: 0, total: results.length, results } };
        }
        await persist();
        return {
          success: true,
          reason: `批量回滚 ${okCount}/${results.length} 条：${results.filter(x => x.success).map(x => x.reason).join('；')}`,
          detail: { count: okCount, total: results.length, results }
        };
      }

      // ③ Range sweep — pure deletions of ALL standing six-block main rows
      // in [from, to] (inclusive). Log times are zero-padded HH:MM, so plain
      // string compare works. Each loop iteration rolls back the FIRST
      // standing in-range row (fresh snapshot every time → same-minute
      // siblings are caught on the next iteration). Rows that fail are
      // remembered and skipped so the loop always terminates.
      const fromT = String(args.from);
      const toT = String(args.to);
      const inRange = (t) => { const s = String(t || ''); return s >= fromT && s <= toT; };
      const failed = new Set();
      const results = [];
      for (;;) {
        const rows = await moodLog.read(today);
        const target = rows.find(r =>
          SIX_BLOCKS.has(r.block) &&
          r.emotion !== '回滚' && r.emotion !== '传播' &&
          inRange(r.time) && !failed.has(`${r.time}|${r.block}`));
        if (!target) break;
        const r = await rollbackOne(target.time, target.block, args.note, 0);
        if (!r.success) { failed.add(`${target.time}|${target.block}`); continue; }
        results.push(r);
      }
      if (results.length === 0) {
        return { success: false, reason: `范围 ${fromT}–${toT} 内没有可回滚的判句主条（回滚替换行/传播子条/思念/无聊/状态行不算目标）` };
      }
      await persist();
      return {
        success: true,
        reason: `范围回滚 ${fromT}–${toT} 共 ${results.length} 笔：${results.map(r => r.reason).join('；')}`,
        detail: { count: results.length, from: fromT, to: toT, results }
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

/** "HH:MM" + file date → timestamp. A log day starts at 04:00, so the real
 *  instant of HH:MM is the day's 04:00 anchor plus the offset from 04:00:
 *  04:00 → 0, 01:05 → 21h05m (i.e. the small hours of the next calendar day).
 *  Month/year rollover falls out of the arithmetic. */
function effectiveTimestamp(fileDate, hhmmStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmmStr || '').trim());
  if (!m) return 0;
  const dayStart = new Date(`${fileDate}T04:00:00`).getTime();
  return dayStart + ((Number(m[1]) - 4 + 24) % 24) * 3600000 + Number(m[2]) * 60000;
}

/** Local HH:MM for a timestamp (E2 state-rollback detail messages). */
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}