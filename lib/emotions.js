import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

let _emotions = null;

/** Read + parse JSON, tolerating a UTF-8 BOM (data files are hand-edited). */
async function readJson(path) {
  const raw = await readFile(path, 'utf-8');
  return raw.replace(/^\uFEFF/, '');
}

async function loadData() {
  if (!_emotions) {
    _emotions = JSON.parse(await readJson(join(DATA_DIR, 'emotions.json')));
  }
}

/**
 * Metadata accessor for the fine-grained emotion table (HER emotions — the
 * judge outputs these keys directly; there is no empathy conversion chain).
 */
export class Emotions {
  constructor() {
    this._loaded = false;
  }

  async _ensure() {
    if (!this._loaded) { await loadData(); this._loaded = true; }
  }

  /** base → weight map for an emotion key */
  async weightsFor(key) {
    await this._ensure();
    return _emotions.emotions[key]?.weights || {};
  }

  /** per-emotion single-deposit cap */
  async capFor(key) {
    await this._ensure();
    return _emotions.emotions[key]?.cap ?? 17.5;
  }

  /** state trigger definition, or null */
  async stateFor(key) {
    await this._ensure();
    return _emotions.emotions[key]?.state || null;
  }

  /** human label */
  async labelFor(key) {
    await this._ensure();
    return _emotions.emotions[key]?.label || key;
  }

  /** closeOnly bases (e.g. shy → ["happy"]), or [] */
  async closeOnlyFor(key) {
    await this._ensure();
    return _emotions.emotions[key]?.closeOnly || [];
  }

  /** alsoMissing flag (lonely → true) */
  async alsoMissingFor(key) {
    await this._ensure();
    return _emotions.emotions[key]?.alsoMissing === true;
  }

  /**
   * closeOnly semantics (SPEC 4.1, user 2026-11-23): shy's happy weight only
   * applies when the emotion is directed at the user (about='her'); otherwise
   * the closeOnly bases are zeroed and the rest renormalized to sum 1.
   * @param {Record<string,number>} weights
   * @param {string[]} closeOnly bases to zero out when not intimate
   * @param {boolean} intimate - about === 'her'
   */
  static adjustCloseOnly(weights, closeOnly, intimate) {
    if (!closeOnly || closeOnly.length === 0 || intimate) return weights;
    const next = {};
    let keep = 0;
    for (const [base, w] of Object.entries(weights)) {
      if (closeOnly.includes(base)) continue;
      next[base] = w;
      keep += w;
    }
    if (keep <= 0) return weights; // nothing left: keep original
    for (const base of Object.keys(next)) next[base] = next[base] / keep;
    return next;
  }
}
