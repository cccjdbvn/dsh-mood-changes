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
   * 水位传播（E31，2026-11-25 用户拍板）：只由「自动核算（tick）」调用，
   * 看结算后的**总值**而不是单笔 delta：
   *   - 源：值 > 60 的 base，溢出 = 值 − 60；
   *   - 量：溢出 × 矩阵系数 × 目标当前状态修饰；
   *   - 目标正向增量封顶 30；目标原本 ≥ 30 → 不加（跳过）；
   *   - **目标当前值 < 20 → 完全不吃传播（加与减都不做，2026-11-26 用户要求）**；
   *   - **负向传播不把目标压到基线以下（2026-11-26 用户要求：不许跌破基线）**；
   *   - 多个源按溢出量降序处理（大情绪先占水位）。
   * 强触发结算（状态触发立即入账）与她主动的 mood_settle 都不调用它。
   * @param {Record<string,number>} values
   * @param {Record<string,number>} mods - 目标 base 的复合状态修饰
   * @param {Record<string,number>|null} baseline - 六情基线（happy 是显示值 x），负向的地板
   * @returns {Array<{base: string, delta: number, parent: string}>}
   */
  static propagateFromValues(values, mods = {}, baseline = null) {
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
        const cur = shownValue(values, target);
        // 值太低的情绪不参与传播：既不加也不压（否则 0 分的块会被零星灌分）。
        if (cur < 20) continue;
        const modFactor = mods[target] ?? 1;
        const delta = src.over * factor * modFactor;
        if (Math.abs(delta) < 0.01) continue;
        if (delta > 0) {
          if (cur >= 30) continue; // 原本就 ≥30：不再加
          addToBase(values, target, Math.min(30, cur + delta) - cur);
        } else {
          // 负向：压到基线为止，不再往下（基线是她的「正常水位」）。
          const floor = typeof baseline?.[target] === 'number' ? baseline[target] : 0;
          addToBase(values, target, Math.max(floor, cur + delta) - cur);
        }
        const actual = Math.round((shownValue(values, target) - cur) * 10) / 10;
        if (Math.abs(actual) < 0.01) continue;
        out.push({ base: target, delta: actual, parent: src.base });
      }
    }
    return out;
  }

  /**
   * 每三次自动核算才传播一次（2026-11-26 用户要求）。
   * 计数存 `state.tickCount`（随 state 落盘，重启不清零），每次 tick 进一次，
   * 模 3 为 0 的那一次才返回 true。
   * @param {object} state
   * @returns {boolean} 本次 tick 要不要做传播
   */
  static shouldPropagateThisTick(state) {
    state.tickCount = (state.tickCount || 0) + 1;
    return state.tickCount % 3 === 0;
  }
}