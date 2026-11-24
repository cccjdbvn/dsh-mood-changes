import { randomUUID } from 'node:crypto';
import { MoodPool } from './pool.js';

const BASE_LABELS = { happy: '乐', sad: '悲', fear: '惧', anger: '怒', surprise: '惊', disgust: '厌' };

const SELF_SOURCE = { kind: 'plugin:dsh-mood-changes' };

/**
 * Builds and injects status bars and knocks.
 * All injected messages carry source.kind 'plugin:dsh-mood-changes' so the plugin's
 * own inbox listener can recognize and skip them (KNOWN-ISSUES B2).
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

  /** Low-level post: inject a user-role message with our plugin source. */
  _post(text) {
    try {
      if (typeof this.agent.inject === 'function') {
        this.agent.inject({
          role: 'user',
          // 2026-11-24：user/message 缺 id 时，host 的存储校验会判成
          // 「session event at seq N lacks an identified message」，
          // dsh-world 重放归档就在这一条上整段卡住（11-24 那天卡了两条）。
          id: randomUUID(),
          content: [{ type: 'text', text }],
          source: SELF_SOURCE
        });
      }
    } catch (e) {
      // agent may not support inject or be disposed
    }
  }

  /** Inject the six-affect status bar. */
  inject(state) {
    this._post(StatusBar.buildStatusText(state));
  }

  /** Inject a knock message (missing / boredom), summary already attached. */
  knock(text) {
    this._post(text);
  }
}