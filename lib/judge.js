import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

let _emotions = null;
let _lexicon = null;
let _judgePrompt = null;
let _judgeSchema = null;

async function loadData() {
  if (!_emotions) {
    _emotions = JSON.parse(await readFile(join(DATA_DIR, 'emotions.json'), 'utf-8'));
    _lexicon = JSON.parse(await readFile(join(DATA_DIR, 'lexicon.json'), 'utf-8'));
    _judgePrompt = await readFile(join(DATA_DIR, 'judge-prompt.md'), 'utf-8');
    _judgeSchema = JSON.parse(await readFile(join(DATA_DIR, 'judge-schema.json'), 'utf-8'));
  }
}

/**
 * Judge a single user message through local LLM or lexicon fallback.
 */
export class Judge {
  constructor(config) {
    this.baseUrl = config.judgeBaseUrl || 'http://127.0.0.1:1234/v1';
    this.apiKey = config.judgeApiKey || '';
    this.model = config.judgeModel || 'local-model';
    this.timeout = config.judgeTimeout || 3000;
    this.temperature = config.judgeTemperature ?? 0.3;
    this._loaded = false;
  }

  async _ensureData() {
    if (!this._loaded) { await loadData(); this._loaded = true; }
  }

  /**
   * Judge a message. Returns { clear, confidence, about, emotions: [{key, intensity, evidence}] }
   * Short messages (≤5 chars) skip the LLM entirely and go straight to lexicon.
   * Falls back to lexicon matching on LLM failure.
   */
  async judge(text, contextMessages) {
    await this._ensureData();

    // Short text: skip LLM, go straight to lexicon
    const trimmed = (text || '').trim();
    if (trimmed.length <= 5) {
      return this._lexiconFallback(trimmed);
    }

    // Try LLM
    try {
      const result = await this._callLlm(text, contextMessages);
      const validated = this._validate(result);
      if (validated) return validated;
    } catch (e) {
      // Fall through to lexicon
    }

    // Try second round with context if available
    if (contextMessages && contextMessages.length > 0) {
      try {
        const result = await this._callLlm(text, contextMessages, true);
        const validated = this._validate(result);
        if (validated) return validated;
      } catch (e) {
        // Fall through to lexicon
      }
    }

    // Lexicon fallback
    return this._lexiconFallback(text);
  }

  async _callLlm(text, contextMessages, isSecondRound) {
    await this._ensureData();

    const messages = [{ role: 'system', content: _judgePrompt }];

    if (isSecondRound && contextMessages) {
      messages.push({ role: 'user', content: `以下是最近对话上下文：\n${contextMessages.join('\n')}\n\n请重新判断最后一句的情绪：\n"${text}"` });
    } else {
      messages.push({ role: 'user', content: text });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
          max_tokens: 256,
          response_format: { type: 'json_object' }
        }),
        signal: controller.signal
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response');

      return JSON.parse(content);
    } finally {
      clearTimeout(timer);
    }
  }

  _validate(result) {
    if (!result || typeof result !== 'object') return null;
    if (result.clear === false && result.confidence < 0.3 && (!result.emotions || result.emotions.length === 0)) {
      // Explicitly unclear → skip
      return { clear: false, confidence: result.confidence || 0, about: 'unknown', emotions: [] };
    }

    const emotions = (result.emotions || []).filter(e => {
      if (!e || !e.key) return false;
      if (!_emotions.emotions[e.key]) return false; // Not in enum
      const intensity = typeof e.intensity === 'number' ? e.intensity : 0;
      return intensity >= 0.15;
    }).slice(0, 2);

    return {
      clear: result.clear !== false,
      confidence: typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : 0.5,
      about: ['her', 'other', 'thing', 'unknown'].includes(result.about) ? result.about : 'unknown',
      emotions
    };
  }

  _lexiconFallback(text) {
    if (!text) return { clear: false, confidence: 0, about: 'unknown', emotions: [] };

    const hits = [];
    const entries = _lexicon.entries;
    const levelScores = _lexicon.levels;

    for (const [key, entry] of Object.entries(entries)) {
      const level = levelScores[entry.level] || 0.4;
      for (const word of entry.words) {
        if (text.includes(word)) {
          hits.push({ key, intensity: level, evidence: word });
          break; // One hit per emotion type
        }
      }
    }

    // Sort by intensity desc, take top 2
    hits.sort((a, b) => b.intensity - a.intensity);
    const top = hits.slice(0, 2).filter(h => h.intensity >= 0.15);

    if (top.length === 0) {
      return { clear: false, confidence: 0, about: 'unknown', emotions: [] };
    }

    return {
      clear: true,
      confidence: Math.min(top[0].intensity + 0.1, 1),
      about: 'unknown',
      emotions: top
    };
  }
}