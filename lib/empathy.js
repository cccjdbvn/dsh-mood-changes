import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

let _emotions = null;
let _empathy = null;

async function loadData() {
  if (!_emotions) {
    _emotions = JSON.parse(await readFile(join(DATA_DIR, 'emotions.json'), 'utf-8'));
    _empathy = JSON.parse(await readFile(join(DATA_DIR, 'empathy.json'), 'utf-8'));
  }
}

/**
 * Convert "his" judged emotion → "her" response emotion via empathy table.
 *
 * Chain: his fine-grained → his six-base weights → dominant base → empathy[about][dominant] → her fine-grained
 */
export class Empathy {
  constructor() {
    this._loaded = false;
  }

  async _ensure() {
    if (!this._loaded) { await loadData(); this._loaded = true; }
  }

  /**
   * @param {{key: string, intensity: number}} hisEmotion - the judged emotion
   * @param {'her'|'other'|'thing'|'unknown'} about
   * @returns {{key: string, intensity: number}|null} her emotion, or null if not applicable
   */
  async convert(hisEmotion, about) {
    await this._ensure();

    const hisDef = _emotions.emotions[hisEmotion.key];
    if (!hisDef || hisDef.noValue) return null;

    // Find his dominant six-base emotion
    const weights = hisDef.weights || {};
    let dominantBase = null;
    let maxW = 0;
    for (const [base, w] of Object.entries(weights)) {
      if (w > maxW) { maxW = w; dominantBase = base; }
    }
    if (!dominantBase) return null;

    // Map six-base to empathy about
    const aboutTable = _empathy.about[about] || _empathy.about['unknown'] || _empathy.about['other'];
    if (!aboutTable) return null;

    const herKey = aboutTable[dominantBase];
    if (!herKey) return null;

    const herDef = _emotions.emotions[herKey];
    if (!herDef) return null;

    return { key: herKey, intensity: hisEmotion.intensity };
  }

  /**
   * Get the weights (base → fraction) for her emotion.
   */
  async weightsFor(herKey) {
    await this._ensure();
    const def = _emotions.emotions[herKey];
    return def?.weights || {};
  }

  /**
   * Get the cap for her emotion.
   */
  async capFor(herKey) {
    await this._ensure();
    const def = _emotions.emotions[herKey];
    return def?.cap ?? 17.5;
  }

  /**
   * Get the state trigger (if any) for her emotion.
   */
  async stateFor(herKey) {
    await this._ensure();
    const def = _emotions.emotions[herKey];
    return def?.state || null;
  }

  /**
   * Get label for fine-grained key.
   */
  async labelFor(key) {
    await this._ensure();
    return _emotions.emotions[key]?.label || key;
  }
}