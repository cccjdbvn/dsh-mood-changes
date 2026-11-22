const HALF_LIVES_HOURS = { happy: 5, sad: 10, anger: 6, fear: 12, surprise: 2.5, disgust: 30 };
const BASES = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust'];
const MIN_VAL = 0;
const MAX_VAL = 100;

/**
 * Six-affect pool: decay toward baseline, apply deltas with caps, clamp.
 */
export class MoodPool {
  /**
   * Apply half-life decay: v' = baseline + (v - baseline) * 0.5^(dt / halfLife)
   * @param {Record<string,number>} values
   * @param {Record<string,number>} baseline
   * @param {number} dtMs - elapsed milliseconds
   * @returns {Record<string,number>} new values
   */
  static decay(values, baseline, dtMs) {
    const hours = dtMs / 3600000;
    const next = { ...values };
    for (const base of BASES) {
      const halfLife = HALF_LIVES_HOURS[base];
      const bl = baseline[base] ?? 5;
      const cur = next[base] ?? 0;
      const factor = Math.pow(0.5, hours / halfLife);
      next[base] = bl + (cur - bl) * factor;
    }
    return next;
  }

  /**
   * Apply a delta to a specific base, respecting the cap.
   * @param {Record<string,number>} values
   * @param {string} base
   * @param {number} delta - signed change
   * @param {number} cap - max absolute single change
   * @returns {number} the actual delta applied
   */
  static apply(values, base, delta, cap = Infinity) {
    const clampedDelta = Math.max(-cap, Math.min(cap, delta));
    const cur = values[base] ?? 0;
    const next = cur + clampedDelta;
    values[base] = Math.max(MIN_VAL, Math.min(MAX_VAL, next));
    return clampedDelta;
  }

  /**
   * Calculate weighted deltas WITHOUT modifying values.
   * @param {Record<string,number>} weights - base → weight (sum to 1)
   * @param {number} score - total score to distribute
   * @param {number} cap - per-base cap
   * @returns {Array<{base: string, delta: number}>}
   */
  static calculateWeighted(weights, score, cap) {
    const deltas = [];
    for (const base of BASES) {
      const w = weights[base] ?? 0;
      if (w === 0) continue;
      const raw = score * w;
      const delta = Math.max(-cap, Math.min(cap, raw));
      if (Math.abs(delta) > 0.001) {
        deltas.push({ base, delta: Math.round(delta * 10) / 10 });
      }
    }
    return deltas;
  }

  /**
   * Apply deltas to values (in-place).
   * @param {Record<string,number>} values
   * @param {Array<{base: string, delta: number}>} deltas
   */
  static applyDeltas(values, deltas) {
    for (const d of deltas) {
      const cur = values[d.base] ?? 0;
      values[d.base] = Math.max(MIN_VAL, Math.min(MAX_VAL, cur + d.delta));
    }
  }

  static clamp(values) {
    for (const base of BASES) {
      values[base] = Math.max(MIN_VAL, Math.min(MAX_VAL, values[base] ?? 0));
    }
  }

  /** Get the dominant emotion name and its value */
  static dominant(values) {
    let best = null;
    let bestVal = -1;
    for (const base of BASES) {
      const v = values[base] ?? 0;
      if (v > bestVal) { bestVal = v; best = base; }
    }
    return { base: best, value: Math.round(bestVal * 10) / 10 };
  }

  /** Get the top-2 emotions (for combined display) */
  static top2(values) {
    const sorted = BASES.map(b => ({ base: b, value: values[b] ?? 0 }))
      .sort((a, b) => b.value - a.value);
    return [sorted[0], sorted[1]];
  }
}