const BASES = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust'];

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
   * @param {Record<string,number>} values
   * @param {string} primaryBase
   * @param {number} primaryDelta - the signed delta applied to primary
   * @returns {Array<{base: string, delta: number, parent: string}>} propagated entries
   */
  static propagate(values, primaryBase, primaryDelta) {
    const propagated = [];
    const matrix = COUPLING_MATRIX[primaryBase];
    if (!matrix) return propagated;

    for (const [target, factor] of Object.entries(matrix)) {
      if (factor === 0) continue;
      const delta = primaryDelta * factor;
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
}