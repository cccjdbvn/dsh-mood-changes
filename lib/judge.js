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
 * Mood judge: reads a conversation round and decides HER (the agent's)
 * current emotion through a local LLM, with a lexicon fallback.
 *
 * Two rounds (user decision 2026-11-23):
 * - Round 1 (the current turn only): did this turn DIRECTLY cause a change
 *   in her emotion? Yes → output the emotion; no → clear:false, no emotions.
 * - Round 2 (recent turns + the current one): judge her emotion RIGHT NOW
 *   with context — she may still be in an earlier state.
 *
 * KNOWN-ISSUES B4 hardening (kept):
 * - All calls are serialized through an internal promise chain.
 * - LLM output is post-processed: ```json fences stripped, outer {...}
 *   extracted, THEN parsed.
 * - On failure the call is retried once WITHOUT response_format (some
 *   OpenAI-compatible backends reject it with 400).
 * - Final failure falls back to the lexicon.
 */
export class Judge {
  constructor(config) {
    this.baseUrl = config.judgeBaseUrl || 'http://127.0.0.1:1234/v1';
    this.apiKey = config.judgeApiKey || '';
    this.model = config.judgeModel || 'local-model';
    this.timeout = config.judgeTimeout || 3000;
    this.temperature = config.judgeTemperature ?? 0.3;
    this.contextPath = config.judgeContextPath || '';
    this._loaded = false;
    this._chain = Promise.resolve();
  }

  async _ensureData() {
    if (!this._loaded) { await loadData(); this._loaded = true; }
  }

  /**
   * Judge context (user decision 2026-11-23): a Markdown file describing HER —
   * who she is, her personality, her speech style, and misjudgment correction
   * notes. Read on EVERY judge call so edits take effect immediately. Missing
   * or unreadable file = no context (plain base prompt).
   */
  async _contextSection() {
    if (!this.contextPath) return '';
    try {
      const raw = await readFile(this.contextPath, 'utf-8');
      const text = raw.replace(/^\uFEFF/, '').trim();
      if (!text) return '';
      // 8k char guard: the judge request itself stays tiny.
      return `\n\n## 她是谁（判她情绪时带着这些理解，包括误判纠偏笔记）\n\n${text.slice(0, 8000)}`;
    } catch {
      return '';
    }
  }

  /**
   * Judge one conversation round. Serialized; safe to call concurrently.
   * @param {string} roundText - the current turn, formatted lines
   *   ("用户：…" / "她：…")
   * @param {string[]} windowLines - recent turns before this one, same line
   *   format, oldest first (round 2 input; may be empty)
   * @param {string} fallbackText - the user-side text of this turn, used for
   *   the short-message lexicon fast path and the LLM-failure fallback
   * @returns {{clear, confidence, about, emotions: [{key, intensity, evidence}]}}
   */
  judge(roundText, windowLines, fallbackText) {
    const run = this._chain.then(() => this._judgeNow(roundText, windowLines, fallbackText));
    this._chain = run.catch(() => {});
    return run;
  }

  async _judgeNow(roundText, windowLines, fallbackText) {
    await this._ensureData();

    // Short user-side text: skip LLM, go straight to lexicon
    const trimmed = (fallbackText ?? '').trim();
    if (trimmed.length <= 5) {
      return this._lexiconFallback(trimmed);
    }

    // Round 1: the current turn alone. Did it DIRECTLY move her? The retry
    // (attempt 1) drops response_format for backends that reject it.
    let first = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this._callLlm(roundText, null, attempt === 0);
        const validated = this._validate(result);
        if (validated) { first = validated; break; }
      } catch (e) {
        // retry (or fall through)
      }
    }

    // A confident "directly caused" verdict (or a confident calm) settles it.
    if (first && first.confidence >= 0.8) return first;

    // Round 2: re-judge with the recent conversation window (the caller
    // never extends the window further back; a 20-minute CD clears it).
    if (windowLines && windowLines.length > 0) {
      try {
        const result = await this._callLlm(roundText, windowLines, true);
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

  async _callLlm(roundText, windowLines, withJsonFormat) {
    const system = _judgePrompt + await this._contextSection();
    const messages = [{ role: 'system', content: system }];

    if (windowLines && windowLines.length > 0) {
      messages.push({ role: 'user', content: `以下是最近几轮对话（按时间序，越靠下越新），最后是刚发生的这一轮：\n${windowLines.join('\n')}\n\n【第二级】请结合前情，判断她此刻的情绪。\n\n刚发生的这一轮：\n${roundText}` });
    } else {
      messages.push({ role: 'user', content: `【第一级】下面是最近这一轮对话。请判断：这轮对话有没有直接引起她情绪的变化？没有就 clear:false、emotions 空数组。\n\n${roundText}` });
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
