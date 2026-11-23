import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const MOOD_DIR = 'mood';
const STATE_FILE = 'state.json';
const BASELINE_FILE = 'baseline.json';

/** Atomic write: tmp file + rename, so a crash never leaves half a JSON. */
async function atomicWrite(path, content) {
  const tmp = path + '.tmp';
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, path);
}

const DEFAULT_BASELINE = { happy: 15, sad: 5, fear: 5, anger: 0, surprise: 0, disgust: 5 };

const DEFAULT_STATE = {
  values: { happy: 15, sad: 5, fear: 5, anger: 0, surprise: 0, disgust: 5 },
  states: [],
  missing: { value: 0, lastDropAt: 0, lastNotifyAt: 0, lastRoll: null, lastHitAt: 0, manualDay: '', manualSum: 0 },
  boredom: { value: 0, lastMsgAt: 0, lastToolAt: 0 },
  lastTickAt: 0,
  lastInjectAt: 0,
  lastActiveAt: 0,
  queue: []
};

function resolvePath(worldDir, ...parts) {
  if (!worldDir) throw new Error('worldDir not configured');
  return join(worldDir, ...parts);
}

export class MoodStore {
  constructor(worldDir) {
    this.worldDir = worldDir;
  }

  moodDir() {
    return resolvePath(this.worldDir, MOOD_DIR);
  }

  async ensureDir() {
    await mkdir(this.moodDir(), { recursive: true });
  }

  async loadState() {
    try {
      const raw = await readFile(join(this.moodDir(), STATE_FILE), 'utf-8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      // Merge with defaults for forward compatibility
      return { ...DEFAULT_STATE, ...parsed, values: { ...DEFAULT_STATE.values, ...(parsed.values || {}) } };
    } catch {
      return { ...DEFAULT_STATE, values: { ...DEFAULT_STATE.values } };
    }
  }

  async saveState(state) {
    await this.ensureDir();
    const toWrite = { ...state };
    // Don't persist the in-memory queue to disk in full; keep last 100 entries max
    if (toWrite.queue && toWrite.queue.length > 100) {
      toWrite.queue = toWrite.queue.slice(-100);
    }
    await atomicWrite(join(this.moodDir(), STATE_FILE), JSON.stringify(toWrite, null, 2));
  }

  async loadBaseline() {
    try {
      const raw = await readFile(join(this.moodDir(), BASELINE_FILE), 'utf-8');
      return { ...DEFAULT_BASELINE, ...JSON.parse(raw.replace(/^\uFEFF/, '')) };
    } catch {
      return { ...DEFAULT_BASELINE };
    }
  }

  async saveBaseline(baseline) {
    await this.ensureDir();
    await atomicWrite(join(this.moodDir(), BASELINE_FILE), JSON.stringify(baseline, null, 2));
  }

  /** Enqueue a delta for the next tick */
  enqueue(state, entry) {
    if (!state.queue) state.queue = [];
    state.queue.push(entry);
  }

  /** Drain and return the queue, clearing it */
  drainQueue(state) {
    const q = state.queue || [];
    state.queue = [];
    return q;
  }
}