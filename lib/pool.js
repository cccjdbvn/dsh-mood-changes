import { toY, toX, Y_MAX } from './happy.js';

const HALF_LIVES_HOURS = { happy: 5, sad: 10, anger: 6, fear: 12, surprise: 2.5, disgust: 30 };
const BASES = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust'];
const MIN_VAL = 0;
const MAX_VAL = 100;

/** Half-life in MILLISECONDS per base (A7 rollback replay uses this). */
export const HALF_LIVES_MS = {
  happy: HALF_LIVES_HOURS.happy * 3600000,
  sad: HALF_LIVES_HOURS.sad * 3600000,
  anger: HALF_LIVES_HOURS.anger * 3600000,
  fear: HALF_LIVES_HOURS.fear * 3600000,
  surprise: HALF_LIVES_HOURS.surprise * 3600000,
  disgust: HALF_LIVES_HOURS.disgust * 3600000,
};

/**
 * Six-affect pool: decay toward baseline, apply deltas with caps, clamp.
 *
 * 「乐」（happy）从 2026-11-26 起是**内部账 + 显示映射**：
 * 存的是 y（无上限），对外显示 x = toX(y)。其余五个 base 仍是 0–100 直接值。
 * 所以这里每个入口都要对 happy 单独处理，别把它当普通 base。
 */
export class MoodPool {
  /**
   * Apply half-life decay: v' = baseline + (v - baseline) * 0.5^(dt / halfLife)
   * happy 例外：对内部账 y 做同样的回归，且衰减后显示值不得低于基线。
   * @param {Record<string,number>} values
   * @param {Record<string,number>} baseline
   * @param {number} dtMs - elapsed milliseconds
   * @param {Set<string>|null} skipBases - bases held at their pre-decay value
   *   this tick (skipDecay: 轻快 holds happy for 2 ticks)
   * @returns {Record<string,number>} new values
   */
  static decay(values, baseline, dtMs, skipBases = null, opts = {}) {
    const hours = dtMs / 3600000;
    const mood = opts.mood || {};
    const next = { ...values };
    for (const base of BASES) {
      if (skipBases && skipBases.has(base)) continue;
      const halfLifeMs = mood[`${base}HalfLifeMs`] ?? HALF_LIVES_MS[base];
      const halfLife = halfLifeMs / 3600000;
      const factor = Math.pow(0.5, hours / halfLife);

      if (base === 'happy') {
        // 乐的内部账 y 走半衰期；衰减完显示值不得低于基线（拍板 2026-11-26）
        const yBase = toY(baseline.happy ?? 5);
        const cur = next.happy ?? yBase;
        const decayed = yBase + (cur - yBase) * factor;
        next.happy = Math.max(yBase, decayed);
        continue;
      }

      const bl = baseline[base] ?? 5;
      const cur = next[base] ?? 0;
      next[base] = bl + (cur - bl) * factor;
    }
    return next;
  }

  /**
   * Apply a delta to a specific base, respecting the cap.
   * happy: delta 是内部账 y 的增量，clamp 到 [0, Y_MAX] 而不是 [0,100]。
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
    if (base === 'happy') {
      values.happy = Math.max(0, Math.min(Y_MAX, next));
      return clampedDelta;
    }
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
   * happy 的 delta 落在内部账 y 上；其余 base 照旧。
   */
  static applyDeltas(values, deltas) {
    for (const d of deltas) {
      const cur = values[d.base] ?? 0;
      const next = cur + d.delta;
      if (d.base === 'happy') {
        values.happy = Math.max(0, Math.min(Y_MAX, next));
        continue;
      }
      values[d.base] = Math.max(MIN_VAL, Math.min(MAX_VAL, next));
    }
  }

  static clamp(values) {
    for (const base of BASES) {
      if (base === 'happy') {
        values.happy = Math.max(0, Math.min(Y_MAX, values.happy ?? 0));
        continue;
      }
      values[base] = Math.max(MIN_VAL, Math.min(MAX_VAL, values[base] ?? 0));
    }
  }

  /**
   * 基线校准（2026-11-26 用户要求）：核算最后一步把六情校回基线以上——
   * 任何来源（传播、遗留数据、手改 state）都不许让值停在基线以下。
   * happy 比的是显示值 x，落回内部账 y。
   * @param {Record<string,number>} values
   * @param {Record<string,number>} baseline - 六情基线（happy 是显示值 x）
   * @returns {string[]} 被抬回基线的 base
   */
  static floorToBaseline(values, baseline) {
    const lifted = [];
    for (const base of BASES) {
      if (base === 'happy') {
        const yBase = toY(baseline.happy ?? 5);
        if ((values.happy ?? 0) < yBase) {
          values.happy = yBase;
          lifted.push(base);
        }
        continue;
      }
      const bl = baseline[base] ?? 0;
      if ((values[base] ?? 0) < bl) {
        values[base] = bl;
        lifted.push(base);
      }
    }
    return lifted;
  }

  /** Get the dominant emotion name and its value (happy 用显示值 x) */
  static dominant(values) {
    let best = null;
    let bestVal = -1;
    for (const base of BASES) {
      const v = base === 'happy' ? toX(values.happy ?? 0) : (values[base] ?? 0);
      if (v > bestVal) { bestVal = v; best = base; }
    }
    return { base: best, value: Math.round(bestVal * 10) / 10 };
  }

  /** Get the top-2 emotions (for combined display), happy 用显示值 x */
  static top2(values) {
    const sorted = BASES
      .map((b) => ({ base: b, value: b === 'happy' ? toX(values.happy ?? 0) : (values[b] ?? 0) }))
      .sort((a, b) => b.value - a.value);
    return [sorted[0], sorted[1]];
  }
}
