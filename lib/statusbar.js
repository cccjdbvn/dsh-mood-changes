import { MoodPool } from './pool.js';

const BASE_LABELS = { happy: '乐', sad: '悲', fear: '惧', anger: '怒', surprise: '惊', disgust: '厌' };

/**
 * Builds and injects status bar messages (steer) and summaries.
 */
export class StatusBar {
  /**
   * @param {object} agent - the DSH Agent instance (has .inject() method)
   */
  constructor(agent) {
    this.agent = agent;
  }

  /**
   * Check if a status bar should be injected (any base > 40, at least 60 min since last).
   */
  static shouldInject(state, now) {
    if (!state.lastInjectAt) return true;
    if ((now - state.lastInjectAt) < 60 * 60000) return false;
    const vals = state.values;
    return Object.values(vals).some(v => v > 40);
  }

  /**
   * Build the status bar message text.
   */
  static buildStatusText(state) {
    const { values, states } = state;
    const top2 = MoodPool.top2(values);
    const dominant = top2[0];
    const second = top2[1];

    let emotionLabel;
    if (dominant.value < 20) {
      emotionLabel = '平静';
    } else if (second.value > 40) {
      emotionLabel = `${BASE_LABELS[dominant.base]}${BASE_LABELS[second.base]}`;
    } else {
      emotionLabel = BASE_LABELS[dominant.base];
    }

    const parts = [];
    for (const b of [dominant, second]) {
      if (b.value >= 20) {
        parts.push(`${BASE_LABELS[b.base]} ${b.value.toFixed(1)}`);
      }
    }

    let text = `【情绪】${emotionLabel}（${parts.join(' / ')}）`;
    
    const activeStates = (states || []).filter(s => s.until > Date.now());
    if (activeStates.length > 0) {
      text += `｜状态：${activeStates.map(s => s.name).join('、')}`;
    }

    return text;
  }

  /**
   * Inject a steer message into the agent.
   * Uses agent.inject() to add a user-role message that enters the next admitted step.
   */
  inject(state) {
    const text = StatusBar.buildStatusText(state);
    try {
      if (typeof this.agent.inject === 'function') {
        this.agent.inject({ role: 'user', content: text });
      }
    } catch (e) {
      // agent may not support inject or be disposed
    }
  }
}