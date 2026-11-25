/**
 * Special states (17 states).
 * 
 * States multiply modifiers on subsequent emotions. Multiple states stack multiplicatively,
 * clamped to 0.5–1.5. Repeat triggers refresh duration, not stack.
 */
export class States {
  /**
   * Activate or refresh a state.
   * @param {Array} states - current state array [{name, until, mod, from, ...}]
   * @param {object} stateDef - {name, minutes, mod, skipRoll, missingStep, boredomStep, missingGain, skipDecay, decayTarget, marker, against, when, branch, ...}
   * @param {number} now - timestamp
   * @param {string} from - which emotion triggered it
   */
  static activate(states, stateDef, now, from) {
    if (!stateDef || !stateDef.name) return;

    const existing = states.find(s => s.name === stateDef.name);
    const duration = (stateDef.minutes || 60) * 60000;

    if (existing) {
      // Refresh duration
      existing.until = now + duration;
      existing.from = from;
    } else {
      const entry = {
        name: stateDef.name,
        until: now + duration,
        mod: stateDef.mod || {},
        from
      };
      // Carry over special fields
      if (stateDef.skipRoll) entry.skipRoll = true;
      if (stateDef.missingStep !== undefined) entry.missingStep = stateDef.missingStep;
      if (stateDef.boredomStep !== undefined) entry.boredomStep = stateDef.boredomStep;
      if (stateDef.missingGain !== undefined) entry.missingGain = stateDef.missingGain;
      if (stateDef.skipDecay !== undefined) entry.skipDecay = stateDef.skipDecay;
      if (stateDef.decayTarget) entry.decayTarget = stateDef.decayTarget;
      if (stateDef.marker) entry.marker = true;
      if (stateDef.against) entry.against = stateDef.against;
      if (stateDef.when) entry.when = stateDef.when;
      if (stateDef.branch) entry.branch = stateDef.branch;
      states.push(entry);
    }
  }

  /** Remove expired states. Returns removed states. */
  static expire(states, now) {
    const expired = [];
    for (let i = states.length - 1; i >= 0; i--) {
      if (states[i].until <= now) {
        expired.push(states.splice(i, 1)[0]);
      }
    }
    return expired;
  }

  /**
   * Compute the composite multiplier for each base.
   * Multiple states multiply; final multiplier clamped to 0.5–1.5.
   */
  static compositeMod(states) {
    const mods = {};
    for (const state of states) {
      for (const [base, factor] of Object.entries(state.mod || {})) {
        mods[base] = (mods[base] || 1) * factor;
      }
    }
    // Clamp
    for (const [base, factor] of Object.entries(mods)) {
      mods[base] = Math.max(0.5, Math.min(1.5, factor));
    }
    return mods;
  }

  /** Check if any active state skips dice roll */
  static hasSkipRoll(states) {
    return states.some(s => s.skipRoll);
  }

  /**
   * skipDecay consumption (SPEC 5.5, user 2026-11-23): while a state with
   * {skipDecay: N, decayTarget: base} is active, each tick skips decay for
   * that base once and decrements the counter ("轻快" = happy skips 2 ticks).
   * Called right before MoodPool.decay; only unexpired entries count.
   * @returns {Set<string>} bases to hold at their pre-decay value this tick
   */
  static consumeSkipDecay(states, now) {
    const skip = new Set();
    for (const s of states) {
      if (s.skipDecay > 0 && s.decayTarget && (s.until ?? 0) > now) {
        skip.add(s.decayTarget);
        s.skipDecay -= 1;
      }
    }
    return skip;
  }

  /** Get missing gain multiplier from states */
  static missingGainMultiplier(states) {
    let m = 1;
    for (const s of states) {
      if (s.missingGain) m *= s.missingGain;
    }
    return m;
  }

  /** Get missing step bonus from states */
  static missingStepBonus(states) {
    let total = 0;
    for (const s of states) {
      if (s.missingStep) total += s.missingStep;
    }
    return total;
  }

  /** Get boredom step bonus from states */
  static boredomStepBonus(states) {
    let total = 0;
    for (const s of states) {
      if (s.boredomStep) total += s.boredomStep;
    }
    return total;
  }

  /**
   * 待办5 方案③：「护着」激活期间，冲着外人（about='other'）的事件怒 ×1.1；
   * 冲用户（about='user'）和其他 base 不加成。
   * 不认具体冒犯者（判官不输出 target），只认方向——护着的本质是对外防御。
   * @returns {number} multiplier for this entry
   */
  static protectionFactor(states, about, base) {
    if (base !== 'anger' || about !== 'other') return 1;
    const now = Date.now();
    return states.some(s => s.name === '护着' && (s.until ?? 0) > now) ? 1.1 : 1;
  }

  /** Format state list for display */
  static formatActive(states) {
    if (states.length === 0) return '';
    return states.map(s => s.name).join('、');
  }
}