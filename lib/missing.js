/**
 * Missing (思念) track.
 *
 * - Base growth: +0.5 per tick (15 min).
 * - Night (23:00–07:00): ×0.4.
 * - Threshold breaks: 0–30 (平时), 30–60 (开始想), 60–80 (很想), 80+ (熬着).
 * - Cross-threshold bonus: 2–4 / 4–8 / 8–12.
 * - Drop: only when "owner" speaks, ×0.8, once per hour cooldown.
 * - Dice roll: from 30+, every 45 min, probability scales with value; night off; ≥80 triggers directly.
 */
export class Missing {
  /**
   * Compute growth for one tick.
   * @param {object} missing - { value, lastDropAt, lastNotifyAt, lastRoll, lastHitAt, manualDay, manualSum }
   * @param {number} now - current timestamp
   * @param {number} gainMultiplier - from states (e.g. worry ×2)
   * @param {number} stepBonus - from states (e.g. lonely +2)
   * @returns {{delta: number, crossedThreshold: boolean, thresholdLabel: string|null}}
   */
  static tick(missing, now, gainMultiplier = 1, stepBonus = 0) {
    const hour = new Date(now).getHours();
    const isNight = hour >= 23 || hour < 7;

    let growth = 0.5 * gainMultiplier;
    if (isNight) growth *= 0.4;
    growth += (stepBonus || 0);

    const oldTier = Missing.tier(missing.value);
    missing.value = Math.min(100, (missing.value || 0) + growth);
    const newTier = Missing.tier(missing.value);

    let bonus = 0;
    let thresholdLabel = null;
    if (newTier > oldTier) {
      const bonusRanges = { 1: [2, 4], 2: [4, 8], 3: [8, 12] };
      const range = bonusRanges[newTier] || [2, 4];
      bonus = range[0] + Math.random() * (range[1] - range[0]);
      missing.value = Math.min(100, missing.value + bonus);
      thresholdLabel = Missing.tierLabel(newTier);
    }

    return {
      delta: growth + bonus,
      crossedThreshold: newTier > oldTier,
      thresholdLabel
    };
  }

  /** Apply a drop from owner interaction. */
  static drop(missing, now) {
    const cooldownMs = 3600000; // 1 hour
    if (missing.lastHitAt && (now - missing.lastHitAt) < cooldownMs) return 0;

    missing.lastHitAt = now;
    const old = missing.value || 0;
    missing.value = Math.max(0, old * 0.8);
    return old - missing.value;
  }

  /**
   * Knock dice (v1 curve): from 30, one roll per 45 minutes, night off,
   * >= 80 knocks directly. p(x) = 1/(e^(6.25-0.1x)+1): ~9.5% at 40, ~44% at
   * 60, ~68% at 70. Updates lastRoll internally (a blocked roll still
   * counts as a roll).
   * @returns {boolean} true when a knock should fire now
   */
  static shouldKnock(m, now) {
    const v = m.value || 0;
    if (v < 30) return false;
    const hour = new Date(now).getHours();
    if (hour >= 23 || hour < 7) return false; // night: no knocks at all
    if (m.lastRoll && now - m.lastRoll < 45 * 60000) return false;
    m.lastRoll = now;
    if (v >= 80) return true; // direct
    const p = 1 / (Math.exp(6.25 - 0.1 * v) + 1);
    return Math.random() < p;
  }

  static tier(val) {
    if (val < 30) return 0;
    if (val < 60) return 1;
    if (val < 80) return 2;
    return 3;
  }

  static tierLabel(tier) {
    return ['平时', '开始想', '很想', '熬着'][tier] || '平时';
  }
}