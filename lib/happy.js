/**
 * 「乐」的曲线核算（2026-11-26 用户拍板）。
 *
 * 存储的是内部账 y（可以无限涨），面板/日志/接口显示的是 x：
 *
 *   y = 47x/165 + (578/33)·ln(1-x/100) + (246/11)·x/(100-x)
 *
 * 也就是 y = f(x)，x = f⁻¹(y)。x 表 0–100 的显示值，y→+∞ 时 x→100
 * （永远到不了 100，只会无限接近）。
 *
 * 入账、衰减都作用在 y 上；对外（面板、状态条、阈值、传播）一律用 x。
 */

const A = 47 / 165;
const B = 578 / 33;
const C = 246 / 11;

/** x 的定义域上限（x=100 时 y 发散，取 99.999 近似）。 */
export const X_MAX = 99.999;
/** y 的安全上限，只是防止数值失控，实际用不到。 */
export const Y_MAX = 1e6;

/** 显示值 x → 内部账 y。 */
export function toY(x) {
  const v = Math.max(0, Math.min(X_MAX, Number(x) || 0));
  if (v <= 0) return 0;
  return A * v + B * Math.log(1 - v / 100) + C * v / (100 - v);
}

/** 内部账 y → 显示值 x（f 单调递增，二分求解）。 */
export function toX(y) {
  const target = Number(y) || 0;
  if (target <= 0) return 0;
  let lo = 0;
  let hi = X_MAX;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (toY(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 显示值取一位小数（面板/日志用）。 */
export function displayX(y) {
  return Math.round(toX(y) * 10) / 10;
}
