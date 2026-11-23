import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

let _emotions = null;
let _lexicon = null;
let _judgePrompt = null;

async function loadData() {
  if (!_emotions) {
    _emotions = JSON.parse(await readJson(join(DATA_DIR, 'emotions.json')));
    _lexicon = JSON.parse(await readJson(join(DATA_DIR, 'lexicon.json')));
    _judgePrompt = await readFile(join(DATA_DIR, 'judge-prompt.md'), 'utf-8');
  }
}

/** Read + parse JSON, tolerating a UTF-8 BOM (data files are hand-edited). */
async function readJson(path) {
  const raw = await readFile(path, 'utf-8');
  return raw.replace(/^\uFEFF/, '');
}

/**
 * Judge a single user message through local LLM or lexicon fallback.
 *
 * KNOWN-ISSUES B4 hardening:
 * - All calls are serialized through an internal promise chain (SPEC: calls
 *   must be serial, never concurrent).
 * - LLM output is post-processed: ```json fences stripped, outer {...}
 *   extracted, THEN parsed. Local models love to decorate JSON.
 * - On failure the call is retried once WITHOUT response_format (some
 *   OpenAI-compatible backends reject it with 400).
 * - Second failure falls back to the lexicon.
 */
export class Judge {
  constructor(config) {
    this.baseUrl = config.judgeBaseUrl || 'http://127.0.0.1:1234/v1';
    this.apiKey = config.judgeApiKey || '';
    this.model = config.judgeModel || 'local-model';
    this.timeout = config.judgeTimeout || 3000;
    this.temperature = config.judgeTemperature ?? 0.3;
    this._loaded = false;
    this._chain = Promise.resolve();
  }

  async _ensureData() {
    if (!this._loaded) { await loadData(); this._loaded = true; }
  }

  /**
   * Judge a message. Serialized; safe to call concurrently.
   * Returns { clear, confidence, about, emotions: [{key, intensity, evidence}] }
   */
  judge(text, contextMessages) {
    const run = this._chain.then(() => this._judgeNow(text, contextMessages));
    this._chain = run.catch(() => {});
    return run;
  }

  async _judgeNow(text, contextMessages) {
    await this._ensureData();

    // Short text: skip LLM, go straight to lexicon
    const trimmed = (text || '').trim();
    if (trimmed.length <= 5) {
      return this._lexiconFallback(trimmed);
    }

    // Round 1: the sentence alone. The retry (attempt 1) drops
    // response_format for backends that reject it.
    let first = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this._callLlm(trimmed, null, attempt === 0);
        const validated = this._validate(result);
        if (validated) { first = validated; break; }
      } catch (e) {
        // retry (or fall through)
      }
    }

    // Confident round 1 → done (clear && confidence >= 0.8).
    if (first && first.clear && first.confidence >= 0.8) return first;

    // Round 2: re-judge with recent context (supplied by the caller; the
    // caller never extends the window further back).
    if (contextMessages && contextMessages.length > 0) {
      try {
        const result = await this._callLlm(trimmed, contextMessages, true);
        const validated = this._validate(result);
        if (validated) return validated;
      } catch (e) {
        // fall through
      }
    }

    // Round 1's verdict (even an unclear one) beats nothing.
    if (first) return first;

    return this._lexiconFallback(trimmed);
  }

  async _callLlm(text, contextMessages, withJsonFormat) {
    const messages = [{ role: 'system', content: _judgePrompt }];

    if (contextMessages && contextMessages.length > 0) {
      messages.push({ role: 'user', content: `以下是最近的对话（按时间序，越靠下越新）：\n${contextMessages.join('\n')}\n\n请结合上下文，判断最后这句的情绪：\n"${text}"` });
    } else {
      messages.push({ role: 'user', content: text });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const body = {
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: 256
      };
      // Some backends (llama.cpp server) reject response_format with 400.
      if (withJsonFormat) body.response_format = { type: 'json_object' };

      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      return this._parseJson(content);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Robustly extract a JSON object from model output: strip ``` fences,
   * trim surrounding prose, then JSON.parse.
   */
  _parseJson(content) {
    if (!content) throw new Error('Empty response');
    let s = String(content).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) s = s.slice(start, end + 1);
    return JSON.parse(s);
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