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

  /** Should we roll dice now? */
  static shouldRoll(missing, now, lastRoll) {
    if ((missing.value || 0) < 30) return false;
    const hour = new Date(now).getHours();
    if (hour >= 23 || hour < 7) return false;
    if (missing.value >= 80) return true; // Direct
    if (lastRoll && (now - lastRoll) < 45 * 60000) return false;

    const prob = (missing.value - 30) / 70;
    return Math.random() < prob;
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