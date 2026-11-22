/**
 * Boredom (无聊) track.
 *
 * - Base growth: +4.5 per tick (15 min).
 * - Night: no growth.
 * - Drop types: 'msg' (收到消息, ×0.7) and 'tool' (做事情, ×0.5).
 * - Cooldown: same type → 1 hour; cross type (A→B or B→A) → 30 min.
 * - Only log drops, not growth.
 * - Dice roll: from 50+, every 45 min; night off.
 */
export class Boredom {
  static MSG_FACTOR = 0.7;
  static TOOL_FACTOR = 0.5;
  static SAME_TYPE_COOLDOWN = 3600000;  // 1 hour
  static CROSS_TYPE_COOLDOWN = 1800000; // 30 min

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

  static shouldRoll(boredom, now, lastRoll) {
    if ((boredom.value || 0) < 50) return false;
    const hour = new Date(now).getHours();
    if (hour >= 23 || hour < 7) return false;
    if (lastRoll && (now - lastRoll) < 45 * 60000) return false;

    const prob = (boredom.value - 50) / 50;
    return Math.random() < prob;
  }
}