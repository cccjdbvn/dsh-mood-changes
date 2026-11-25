/**
 * Boredom (无聊) track.
 *
 * - Base growth: +4.5 per tick (15 min).
 * - Night: no growth.
 * - Drop types: 'msg' (收到消息, ×0.7) and 'tool' (做事情, ×0.6).
 * - Cooldown: same type → 1 hour; cross type (A→B or B→A) → 30 min.
 * - 轮次计数（E30，2026-11-25 用户拍板）：把原来「1 小时窗口内第 N 次工具
 *   调用」改成「A 之后第 N 个调过工具的对话轮」：
 *     · A = 任何一次**非计数触发**的无聊衰减（消息 ×0.7 或 工具 ×0.6）真正
 *       落地。A 一落地就开窗，**A 那一轮记第 0 轮**（不 +1）。
 *     · 计数单位是「轮」：一个 turn/end 最多 +1，且只有本轮**调用过工具**才
 *       +1；同一轮里调 48 次工具仍然只算这一轮。
 *     · A 之后一个窗口（默认 1 小时）内数到**第 5 轮** → 触发 B（×0.6），
 *       只一次；B 之后关窗，等下一次 A 重新开窗。
 *     · 数到第 5 轮时若已超窗口 → 这次 B 作废，关窗等下一次 A。
 *   （2026-11-25 之前的实现按工具调用次数数：同一轮 48 次调用把窗口反复
 *   数到 5，16 分钟内 B 发了 6 笔——这就是 E30 修的现场。）
 * - E33（2026-11-25 晚）：消息与工具合并成同一个事件 A，共用 1 小时 CD；
 *   B 触发时也刷新这条 CD（lastAAt = now），所以 B 之后一小时内不会有 A，
 *   也不会攒出下一个 B（取代 E32 的 bQuietUntil 写法）。
 * - Only log drops, not growth.
 * - Dice roll: from 50+, every 45 min; night off.
 */
import { isNightHour } from './tuning.js';

export class Boredom {
  static MSG_FACTOR = 0.7;
  static TOOL_FACTOR = 0.6;
  static A_COOLDOWN = 3600000; // A 事件冷却（消息与工具共用，1 小时）
  static COUNT_WINDOW_MS = 3600000;     // A 之后 B 的有效窗口（默认 1 小时）
  static TURN_SECOND_AT = 5;            // A 之后第几个「调过工具的轮」触发 B

  /**
   * Compute growth for one tick.
   * @param {object} boredom - { value, lastMsgAt, lastToolAt }
   * @param {number} now
   * @param {number} stepBonus - from states (e.g. "没劲" +5)
   * @returns {number} delta
   */
  static tick(boredom, now, stepBonus = 0, opts = {}) {
    const tuning = opts.boredom || {};
    if (isNightHour(now, opts.night)) return 0;

    const growth = (tuning.baseGrowth ?? 4.5) + (stepBonus || 0);
    boredom.value = Math.min(100, (boredom.value || 0) + growth);
    return growth;
  }

  /**
   * Apply a drop from interaction（A：非计数触发的衰减，冷却允许时才落地）.
   * @param {object} boredom - { value, lastMsgAt, lastToolAt }
   * @param {number} now
   * @param {'msg'|'tool'} kind
   * @returns {number} actual drop amount (0 if blocked by cooldown)
   */
  static drop(boredom, now, kind, opts = {}) {
    const tuning = opts.boredom || {};
    // E33（2026-11-25 晚，用户拍板）：消息与工具**合并成同一个事件 A**，共用一条
    // 1 小时冷却（取消原来的「同类型 1h + 跨类型 30min」两套 CD）。B 触发时也
    // 刷新这条 CD（lastAAt = now），所以 B 之后一小时内不会有 A。
    const cooldownMs = tuning.sameTypeCooldownMs ?? Boredom.A_COOLDOWN;
    if (boredom.lastAAt && (now - boredom.lastAAt) < cooldownMs) return 0;
    boredom.lastAAt = now;
    const factor = kind === 'msg'
      ? (tuning.msgFactor ?? Boredom.MSG_FACTOR)
      : (tuning.toolFactor ?? Boredom.TOOL_FACTOR);
    const old = boredom.value || 0;
    boredom.value = Math.max(0, old * factor);
    return old - boredom.value;
  }

  /**
   * A 落地 → 开一个新的轮次窗口（A 那一轮 = 第 0 轮）。
   * 消息侧和工具侧的 A 都走这里：用户拍板「两个都算」。
   * @param {object} boredom
   * @param {number} now - A 的时刻
   */
  static startCountWindow(boredom, now) {
    boredom.countStartAt = now;
    boredom.turnCount = 0;
  }

  /**
   * 一轮结束（turn/end）时的轮次账。
   *
   * 只在 A 开过窗之后计数；窗口过期即关窗（这次 B 作废）；
   * 只有「本轮调用过工具、且本轮不是 A 那一轮」才 +1；
   * 数到第 N 轮（默认 5）发 B（×0.6），发完关窗等下一次 A。
   *
   * @param {object} boredom - { value, ..., countStartAt, turnCount }
   * @param {number} now - 轮结束时刻
   * @param {boolean} countThisTurn - 本轮是否 +1（= 调过工具 且 不是 A 那一轮）
   * @param {object} opts - tuning
   * @returns {{b: number, turnCount: number, expired: boolean, fired: boolean}}
   *   b: B 的实际衰减量（0 = 没发）；expired: 本次是否因超窗口关窗
   */
  static onTurnEnd(boredom, now, countThisTurn, opts = {}) {
    const tuning = opts.boredom || {};
    const windowMs = tuning.toolWindowMs ?? Boredom.COUNT_WINDOW_MS;
    const secondAt = tuning.toolSecondAt ?? Boredom.TURN_SECOND_AT;
    const since = boredom.countStartAt || 0;

    // 没有 A 就没有 B：不开窗时轮次一概不数。
    if (!since) return { b: 0, turnCount: 0, expired: false, fired: false };

    // 超窗口：这次 B 作废（用户拍板），关窗等下一次 A。
    if (now - since > windowMs) {
      boredom.countStartAt = 0;
      boredom.turnCount = 0;
      return { b: 0, turnCount: 0, expired: true, fired: false };
    }

    // 没调过工具的轮 / A 那一轮（第 0 轮）不 +1。
    if (!countThisTurn) {
      return { b: 0, turnCount: boredom.turnCount || 0, expired: false, fired: false };
    }

    boredom.turnCount = (boredom.turnCount || 0) + 1;
    if (boredom.turnCount < secondAt) {
      return { b: 0, turnCount: boredom.turnCount, expired: false, fired: false };
    }

    // 第 N 轮 → B（×0.6），只一次；之后关窗。
    const old = boredom.value || 0;
    boredom.value = Math.max(0, old * (tuning.toolFactor ?? Boredom.TOOL_FACTOR));
    const b = old - boredom.value;
    boredom.countStartAt = 0;
    boredom.turnCount = 0;
    // E33：B 刷新 A 的冷却（1h）——效果等同 E32 的静默期，且与 A 共用一条 CD。
    boredom.lastAAt = now;
    return { b, turnCount: 0, expired: false, fired: true };
  }

  /**
   * Knock dice (v1 curve, shifted to start at 50): one roll per 45 minutes,
   * night off, >= 80 knocks directly. p(x) = 1/(e^(6.25-0.1x)+1).
   * @returns {boolean} true when a knock should fire now
   */
  static shouldKnock(b, now, opts = {}) {
    const v = b.value || 0;
    if (v < 50) return false;
    if (isNightHour(now, opts.night)) return false;
    if (b.lastRoll && now - b.lastRoll < 45 * 60000) return false;
    b.lastRoll = now;
    if (v >= 80) { b.lastRollHit = true; return true; } // direct
    const p = 1 / (Math.exp(6.25 - 0.1 * v) + 1);
    const hit = Math.random() < p;
    b.lastRollHit = hit; // 面板要显示「上次掷骰中没中」（2026-11-24 用户需求）
    return hit;
  }
}
