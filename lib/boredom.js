/**
 * Boredom (无聊) track.
 *
 * - Base growth: +4.5 per tick (15 min).
 * - Night: no growth.
 * - Drop types: 'msg' (收到消息, ×0.7) and 'tool' (做事情, ×0.6).
 * - Cooldown: same type → 1 hour; cross type (A→B or B→A) → 30 min.
 * - Tool-side window (2026-11-23, 用户拍板): tool calls are counted in a
 *   rolling 1-hour window. The 1st call of a window drops ×0.6 (normal
 *   cooldown rules apply); the 5th call within the window fires a SECOND
 *   drop ×0.6 that skips only the same-type 1h CD (E8: it still respects
 *   the cross-type 30-min CD — held, not reset, while a msg drop is fresh;
 *   the next call after the CD passes fires it). Max two drops per window;
 *   the window resets after the second drop. Msg side untouched.
 * - Only log drops, not growth.
 * - Dice roll: from 50+, every 45 min; night off.
 */
export class Boredom {
  static MSG_FACTOR = 0.7;
  static TOOL_FACTOR = 0.6;
  static SAME_TYPE_COOLDOWN = 3600000;  // 1 hour
  static CROSS_TYPE_COOLDOWN = 1800000; // 30 min
  static TOOL_WINDOW_MS = 3600000;      // rolling window for tool calls
  static TOOL_SECOND_AT = 5;            // Nth call in window fires the 2nd drop

  /**
   * Compute growth for one tick.
   * @param {object} boredom - { value, lastMsgAt, lastToolAt }
   * @param {number} now
   * @param {number} stepBonus - from states (e.g. "没劲" +5)
   * @returns {number} delta
   */
  static tick(boredom, now, stepBonus = 0) {
    const hour = new Date(now).getHours();
    if (hour >= 23 || hour < 7) return 0;

    const growth = 4.5 + (stepBonus || 0);
    boredom.value = Math.min(100, (boredom.value || 0) + growth);
    return growth;
  }

  /**
   * Apply a drop from interaction.
   * @param {object} boredom - { value, lastMsgAt, lastToolAt }
   * @param {number} now
   * @param {'msg'|'tool'} kind
   * @returns {number} actual drop amount (0 if blocked by cooldown)
   */
  static drop(boredom, now, kind) {
    const ownKey = kind === 'msg' ? 'lastMsgAt' : 'lastToolAt';
    const otherKey = kind === 'msg' ? 'lastToolAt' : 'lastMsgAt';
    const factor = kind === 'msg' ? Boredom.MSG_FACTOR : Boredom.TOOL_FACTOR;

    // Same type: 1 hour cooldown
    if (boredom[ownKey] && (now - boredom[ownKey]) < Boredom.SAME_TYPE_COOLDOWN) return 0;

    // Cross type: 30 min cooldown
    if (boredom[otherKey] && (now - boredom[otherKey]) < Boredom.CROSS_TYPE_COOLDOWN) return 0;

    boredom[ownKey] = now;
    const old = boredom.value || 0;
    boredom.value = Math.max(0, old * factor);
    return old - boredom.value;
  }

  /**
   * Tool-call entry point (2026-11-23, 用户拍板; E8 2026-11-24): rolling
   * 1-hour window. 1st call of a window → normal drop (×0.6, cooldown rules
   * apply). 5th call within the window → SECOND drop ×0.6, skipping only the
   * same-type 1h CD (it happens inside the same hour by construction) — the
   * cross-type 30-min CD HOLDS it: while a msg drop is < 30 min old the
   * second drop waits (count stays ≥ 5), firing on the next call after the
   * CD passes. After the second drop fires the window resets (count = 0 —
   * the next call starts a fresh window as its #1). The second drop does
   * NOT touch lastToolAt: it is a bonus drop, not a cooldown anchor.
   * @param {object} boredom - { value, lastMsgAt, lastToolAt, toolWindowStart, toolWindowCount }
   * @param {number} now
   * @returns {{first: number, second: number}} actual drop amounts (0 = none)
   */
  static onToolCall(boredom, now) {
    // Window bookkeeping counts EVERY qualifying call, whether or not the
    // first drop actually fired (it may be blocked by cooldowns).
    if (!boredom.toolWindowStart || now - boredom.toolWindowStart >= Boredom.TOOL_WINDOW_MS) {
      boredom.toolWindowStart = now;
      boredom.toolWindowCount = 1;
    } else {
      boredom.toolWindowCount = (boredom.toolWindowCount || 0) + 1;
    }

    const first = Boredom.drop(boredom, now, 'tool');

    let second = 0;
    // E8 (2026-11-24)：第二次衰减只跳过同类型 1h CD（它本来就发生在同小时内），
    // 但必须尊重跨类型 30min 互斥——消息衰减后半小时内不发（08:12 消息 →
    // 08:19 第5次追加直接打了，就是漏了这个）。被压住时不重置计数（保持 ≥5），
    // CD 过后的下一次调用补发：活干了，衰减只是排队等 CD。
    const crossBlocked = boredom.lastMsgAt && (now - boredom.lastMsgAt) < Boredom.CROSS_TYPE_COOLDOWN;
    if (boredom.toolWindowCount >= Boredom.TOOL_SECOND_AT && !crossBlocked) {
      boredom.toolWindowStart = now; // window consumed → next call is #1 of a new one
      boredom.toolWindowCount = 0;
      const old = boredom.value || 0;
      boredom.value = Math.max(0, old * Boredom.TOOL_FACTOR);
      second = old - boredom.value;
    }
    return { first, second };
  }

  /**
   * Knock dice (v1 curve, shifted to start at 50): one roll per 45 minutes,
   * night off, >= 80 knocks directly. p(x) = 1/(e^(6.25-0.1x)+1).
   * @returns {boolean} true when a knock should fire now
   */
  static shouldKnock(b, now) {
    const v = b.value || 0;
    if (v < 50) return false;
    const hour = new Date(now).getHours();
    if (hour >= 23 || hour < 7) return false;
    if (b.lastRoll && now - b.lastRoll < 45 * 60000) return false;
    b.lastRoll = now;
    if (v >= 80) return true; // direct
    const p = 1 / (Math.exp(6.25 - 0.1 * v) + 1);
    return Math.random() < p;
  }
}