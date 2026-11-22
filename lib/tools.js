import { MoodLog } from './log.js';

const BASES = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust'];

/**
 * Register the three model-facing tools: mood_log, mood_rollback, mood_baseline.
 */
export function registerTools(ctx, store, baselineRef, getState) {
  const tools = ctx.get('tools');
  if (!tools) return [];

  const disposers = [];

  // mood_log — query log entries
  disposers.push(tools.register({
    name: 'mood_log',
    description: '查询指定日期的情绪日志，可按情绪块筛选。返回当天的 Markdown 日志条目列表。',
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
      const log = new MoodLog(store.worldDir);
      const date = args.date || MoodLog.dateFor(Date.now());
      const entries = await log.read(date, args.block || null);
      return { date, entries };
    }
  }));

  // mood_rollback — roll back an entry (same day only)
  disposers.push(tools.register({
    name: 'mood_rollback',
    description: `回滚当日日志中的某条情绪记录。只能回滚今天的记录（按事件日期）。在日志中标记"已回滚"并写入新值。`,
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期，YYYY-MM-DD；只能填今天' },
        oldRow: { type: 'string', description: '要回滚的那一行的部分文本（用于匹配，如时间+情绪）' },
        newDelta: { type: 'number', description: '新的变化值；0 表示删除（恢复原值）' },
        newReason: { type: 'string', description: '回滚原因' }
      },
      required: ['date', 'oldRow']
    },
    output: {
      schema: { type: 'object', properties: { success: { type: 'boolean' }, reason: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    async execute(args) {
      const today = MoodLog.dateFor(Date.now());
      if (args.date !== today) {
        return { success: false, reason: `只能回滚当天的记录（${today}），不能回滚 ${args.date}` };
      }
      const log = new MoodLog(store.worldDir);
      return await log.rollback(args.date, args.oldRow, args.newDelta ?? 0, args.newReason ?? '');
    }
  }));

  // mood_baseline — write baseline.json
  disposers.push(tools.register({
    name: 'mood_baseline',
    description: '写入六情基线值。基线是情绪回归的目标值，下次 tick 生效。六条值范围 0–100。',
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
      return { success: true, baseline: current };
    }
  }));

  return disposers;
}