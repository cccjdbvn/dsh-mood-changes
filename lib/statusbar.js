import { randomUUID } from 'node:crypto';
import { MoodPool } from './pool.js';
import { toX } from './happy.js';

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
   * 六情上下文刷新判据（E28，2026-11-25 用户要求）：
   * 任意一条 > 40 才有内容；距上次刷新满 1.5 小时才换新内容。
   * 内容由调用方写进 `systemPrompt.context` 的文本里，不再作为消息注入。
   */
  static shouldRefresh(state, now, intervalMs = 90 * 60000) {
    const raw = state?.values ?? {};
    const vals = Object.values({ ...raw, happy: toX(raw.happy ?? 0) });
    const top = vals.length ? Math.max(...vals) : 0;
    if (!(top > 40)) return false;
    return (now - (state?.lastStatusAt || 0)) >= intervalMs;
  }

  /** 构造带 id/source 的 user 消息（E10：缺 id 会让归档校验整份失败）。 */
  _message(text) {
    return {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text }],
      source: SELF_SOURCE
    };
  }

  /**
   * 敲门：要她**真的收到**，所以走 `followup`（排队下一轮 + 叫醒驱动）。
   * E29（2026-11-25）：以前用 `inject`——它只把消息塞进 next-step 上下文、
   * **不叫醒**；她不在回合里时，敲门就静静躺在 inbox 里（12:55 那次就是这样，
   * 消息插进去之后一直没有回合，直到下次她开口才冒出来，已过期）。
   * 没有 followup 的宿主退回 inject（至少不会丢）。
   * @returns {boolean} 是否已交出去
   */
  knock(text) {
    const msg = this._message(text);
    try {
      if (typeof this.agent.followup === 'function') {
        this.agent.followup(msg);
        return true;
      }
      if (typeof this.agent.inject === 'function') {
        this.agent.inject(msg);
        return true;
      }
    } catch (e) {
      // agent may be disposed
    }
    return false;
  }
}