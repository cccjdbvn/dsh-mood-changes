import { toX, toY } from './happy.js';

const BASES = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust'];

/** 参与比较/传播的「显示值」：happy 存内部账 y，对外一律按 x 算。 */
function shownValue(values, base) {
  return base === 'happy' ? toX(values.happy ?? 0) : (values[base] ?? 0);
}

/** 把 delta 加到某个 base 上（happy 的 delta 按显示值 x 语义换算回 y）。 */
function addToBase(values, base, delta) {
  if (base === 'happy') {
    const curX = toX(values.happy ?? 0);
    const nextX = Math.max(0, Math.min(100, curX + delta));
    values.happy = toY(nextX);
    return toX(values.happy) - curX;
  }
  const cur = values[base] ?? 0;
  const next = Math.max(0, Math.min(100, cur + delta));
  values[base] = next;
  return next - cur;
}

/**
 * Coupling: event propagation + tick damping (方案 C).
 *
 * Propagation matrix: when an event adds to one base, a fraction propagates
 * to related bases (positive = mutual reinforcement, negative = mutual inhibition).
 * 
 * Tick damping: at each tick, bases > 60 press down on bases < 60.
 * Effect is weak (max ±1 per pair per tick).
 */
const COUPLING_MATRIX = {
  // happy → others
  happy: { sad: -0.05, anger: -0.1, fear: -0.05, disgust: -0.05 },
  // sad → others
  sad: { anger: 0.05, fear: 0.1, disgust: 0.05 },
  // anger → others
  anger: { sad: 0.05, disgust: 0.1, fear: 0.05 },
  // fear → others
  fear: { sad: 0.1, surprise: 0.05 },
  // surprise → others
  surprise: { happy: 0.05, fear: 0.05 },
  // disgust → others
  disgust: { anger: 0.05, sad: 0.05 }
};

export class Coupling {
  /**
   * Event propagation: spread fraction of the primary delta to related bases.
   * Propagated deltas are also multiplied by the active state modifiers
   * (KNOWN-ISSUES A5: modifiers apply to main entries AND propagation rows).
   * Runs at settlement time, not at judge time (A6).
   * @param {Record<string,number>} values
   * @param {string} primaryBase
   * @param {number} primaryDelta - the settled (already modified) delta of the primary
   * @param {Record<string,number>} mods - composite state modifiers per base
   * @returns {Array<{base: string, delta: number, parent: string}>} propagated entries
   */
  static propagate(values, primaryBase, primaryDelta, mods = {}) {
    const propagated = [];
    const matrix = COUPLING_MATRIX[primaryBase];
    if (!matrix) return propagated;

    for (const [target, factor] of Object.entries(matrix)) {
      if (factor === 0) continue;
      const modFactor = mods[target] ?? 1;
      const delta = primaryDelta * factor * modFactor;
      if (Math.abs(delta) < 0.01) continue;
      const cur = values[target] ?? 0;
      const next = Math.max(0, Math.min(100, cur + delta));
      values[target] = next;
      propagated.push({
        base: target,
        delta: Math.round(delta * 10) / 10,
        parent: primaryBase
      });
    }
    return propagated;
  }

  /**
   * Tick damping: bases > 60 press on bases < 60 (max ±1 per pair).
   * @param {Record<string,number>} values
   * @param {number} dampingCoeff - 0-1 (start at 0, ramp up after a week)
   * @returns {Array<{from: string, to: string, delta: number}>}
   */
  static dampen(values, dampingCoeff = 0) {
    const damped = [];
    if (dampingCoeff <= 0) return damped;

    for (const presser of BASES) {
      const pressVal = values[presser] ?? 0;
      if (pressVal <= 60) continue;

      for (const pressed of BASES) {
        if (presser === pressed) continue;
        const pressedVal = values[pressed] ?? 0;
        if (pressedVal >= 60) continue; // Only press on those < 60
        if (pressedVal >= 30) continue; // Stop being pressed below 30? SPEC says < 30 stop, so only press 30-60

        const matrixEntry = COUPLING_MATRIX[presser]?.[pressed] ?? 0;
        // Pressing: negative matrix entries mean the presser suppresses the pressed
        // For damping, we only apply suppression (negative influence)
        if (matrixEntry >= 0) continue;

        const delta = Math.abs(matrixEntry) * dampingCoeff * (pressVal - 60) / 40;
        const clampedDelta = Math.max(-1, Math.min(0, -delta)); // Always negative for damping, max -1
        if (Math.abs(clampedDelta) < 0.01) continue;

        const cur = values[pressed] ?? 0;
        const next = Math.max(0, Math.min(100, cur + clampedDelta));
        values[pressed] = next;
        damped.push({ from: presser, to: pressed, delta: Math.round(clampedDelta * 10) / 10 });
      }
    }
    return damped;
  }

  /**
   * 水位传播（E31，2026-11-25 用户拍板）：只由「自动核算（tick）」调用一次，
   * 看结算后的**总值**而不是单笔 delta：
   *   - 源：值 > 60 的 base，溢出 = 值 − 60；
   *   - 量：溢出 × 矩阵系数 × 目标当前状态修饰；
   *   - 目标正向增量封顶 30；目标原本 ≥ 30 → 不加（跳过）；
   *   - 多个源按溢出量降序处理（大情绪先占水位）。
   * 强触发结算（状态触发立即入账）与她主动的 mood_settle 都不调用它。
   * @param {Record<string,number>} values
   * @param {Record<string,number>} mods - 目标 base 的复合状态修饰
   * @returns {Array<{base: string, delta: number, parent: string}>}
   */
  static propagateFromValues(values, mods = {}) {
    const out = [];
    const sources = BASES
      .map((base) => ({ base, over: shownValue(values, base) - 60 }))
      .filter((s) => s.over > 0)
      .sort((a, b) => b.over - a.over);
    for (const src of sources) {
      const matrix = COUPLING_MATRIX[src.base];
      if (!matrix) continue;
      for (const [target, factor] of Object.entries(matrix)) {
        if (factor === 0) continue;
        const modFactor = mods[target] ?? 1;
        const delta = src.over * factor * modFactor;
        if (Math.abs(delta) < 0.01) continue;
        const cur = shownValue(values, target);
        if (delta > 0) {
          if (cur >= 30) continue; // 原本就 ≥30：不再加
          addToBase(values, target, Math.min(30, cur + delta) - cur);
        } else {
          addToBase(values, target, Math.max(0, cur + delta) - cur);
        }
        const actual = Math.round((shownValue(values, target) - cur) * 10) / 10;
        if (Math.abs(actual) < 0.01) continue;
        out.push({ base: target, delta: actual, parent: src.base });
      }
    }
    return out;
  }
}