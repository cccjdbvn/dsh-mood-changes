import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_DIR = 'room';
const LOG_SUBDIR = '情绪日志';

const BASE_TO_BLOCK = { happy: '乐', sad: '悲', anger: '怒', fear: '惧', surprise: '惊', disgust: '厌' };

/** Atomic write: tmp file + rename, so a crash never leaves half a file. */
async function atomicWrite(path, content) {
  const tmp = path + '.tmp';
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, path);
}

/** Escape table-breaking pipes in free text columns. */
function sanitizeText(s) {
  return (s || '').replace(/\|/g, '｜');
}

/**
 * Daily Markdown log: eight blocks (six emotions + missing + boredom) + state block.
 *
 * All writes go through an internal promise chain (A2), so concurrent
 * fire-and-forget appends cannot overwrite each other. Use appendBatch()
 * to write several rows for one event in a single read-modify-write.
 */
export class MoodLog {
  constructor(worldDir) {
    this.worldDir = worldDir;
    this._chain = Promise.resolve();
  }

  logDir() {
    return join(this.worldDir, LOG_DIR, LOG_SUBDIR);
  }

  async ensureDir() {
    await mkdir(this.logDir(), { recursive: true });
  }

  filePath(dateStr) {
    return join(this.logDir(), `${dateStr}.md`);
  }

  /**
   * Determine the log date for a timestamp.
   * Cutoff is 04:00 local time. Uses LOCAL date parts, never toISOString
   * (UTC) — see KNOWN-ISSUES A1.
   */
  static dateFor(ts) {
    const d = new Date(ts);
    if (d.getHours() < 4) {
      d.setDate(d.getDate() - 1);
    }
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Append one entry. Serialized; safe to call concurrently / fire-and-forget.
   * @param {object} entry - { ts, block, emotion, delta, origDelta?, reason, stateNote? }
   *   delta: the effective value (after state modifiers). origDelta: the raw
   *   value before modifiers, written as （原 X） when present and different.
   */
  async append(entry) {
    const run = this._chain.then(() => this._appendNow(entry));
    this._chain = run.catch(() => {});
    return run;
  }

  /**
   * Append several entries in one serialized read-modify-write per date file.
   * Rows are inserted in the given order; within a block they stay
   * time-sorted.
   */
  async appendBatch(entries) {
    if (!entries || entries.length === 0) return;
    const run = this._chain.then(() => this._appendAllNow(entries));
    this._chain = run.catch(() => {});
    return run;
  }

  async _appendAllNow(entries) {
    await this.ensureDir();
    const byDate = new Map();
    for (const e of entries) {
      const dateStr = MoodLog.dateFor(e.ts);
      if (!byDate.has(dateStr)) byDate.set(dateStr, []);
      byDate.get(dateStr).push(e);
    }
    for (const [dateStr, list] of byDate) {
      let content = await this._readOrInit(dateStr);
      for (const e of list) {
        content = this._insertRowFor(e, content);
      }
      await atomicWrite(this.filePath(dateStr), content);
    }
  }

  async _appendNow(entry) {
    await this.ensureDir();
    const dateStr = MoodLog.dateFor(entry.ts);
    const content = await this._readOrInit(dateStr);
    const updated = this._insertRowFor(entry, content);
    await atomicWrite(this.filePath(dateStr), updated);
  }

  async _readOrInit(dateStr) {
    const path = this.filePath(dateStr);
    try {
      return await readFile(path, 'utf-8');
    } catch {
      return `# ${dateStr} 情绪日志\n\n> 八块固定顺序：乐 / 悲 / 怒 / 惧 / 惊 / 厌 / 思念 / 无聊；最后一块「状态」记状态触发。\n`;
    }
  }

  _formatRow(entry) {
    const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const label = sanitizeText(entry.emotion || '');
    let deltaStr;
    if (entry.origDelta !== undefined && entry.origDelta !== entry.delta) {
      deltaStr = `${entry.delta >= 0 ? '+' : ''}${entry.delta}（原 ${entry.origDelta}）`;
    } else {
      deltaStr = `${entry.delta >= 0 ? '+' : ''}${entry.delta}`;
    }
    const reason = sanitizeText((entry.reason || '').slice(0, 70));
    const stateCol = sanitizeText(entry.stateNote || '—');
    return `| ${time} | ${label} | ${deltaStr} | ${reason} | ${stateCol} |`;
  }

  /**
   * Insert entry's row into the correct block of the log content,
   * keeping rows time-sorted within the block. Returns updated content.
   */
  _insertRowFor(entry, content) {
    const row = this._formatRow(entry);
    const blockHeader = entry.block === '状态' ? '## 状态' : `## ${entry.block}`;
    const lines = content.split('\n');
    const result = [];

    for (let i = 0; i < lines.length; i++) {
      result.push(lines[i]);
      if (lines[i].trim() === blockHeader) {
        // Copy blank line + table header rows, then collect existing rows.
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === '' || lines[j].startsWith('| 时间') || lines[j].startsWith('|---'))) {
          result.push(lines[j]);
          j++;
        }
        const tableLines = [];
        while (j < lines.length && lines[j].startsWith('|')) {
          tableLines.push(lines[j]);
          j++;
        }
        tableLines.push(row);
        // Rows start with "| HH:MM", so lexicographic sort keeps time order.
        tableLines.sort();
        for (const tl of tableLines) result.push(tl);
        while (j < lines.length) result.push(lines[j++]);
        return result.join('\n');
      }
    }

    // Block doesn't exist yet: append it at the end.
    result.push('', blockHeader, '', '| 时间 | 情绪 | 变化 | 原因 | 状态 |', '|---|---|---|---|---|', row);
    return result.join('\n');
  }

  /**
   * Read log entries for a date, optionally filtered by block.
   */
  async read(dateStr, blockFilter) {
    const path = this.filePath(dateStr);
    try {
      const content = await readFile(path, 'utf-8');
      return this._parse(content, blockFilter);
    } catch {
      return [];
    }
  }

  _parse(content, blockFilter) {
    const entries = [];
    const lines = content.split('\n');
    let currentBlock = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('## ')) {
        currentBlock = trimmed.slice(3).trim();
        continue;
      }
      if (!trimmed.startsWith('| ') || trimmed.startsWith('| 时间')) continue;
      if (trimmed.startsWith('| ~~')) continue; // rolled-back rows are skipped
      if (blockFilter && currentBlock !== blockFilter) continue;

      const cols = trimmed.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 4) continue;

      entries.push({
        block: currentBlock,
        time: cols[0] || '',
        emotion: cols[1] || '',
        delta: cols[2] || '',
        reason: cols[3] || '',
        state: cols[4] || '',
        raw: trimmed
      });
    }
    return entries;
  }

  /** Roll back: mark an entry as rolled back and write the replacement row.
   * NOTE (KNOWN-ISSUES A7): this only annotates the log; it does NOT adjust
   * state.values. Numeric rollback is pending a decision. */
  async rollback(dateStr, oldRow, newDelta = 0, newReason = '') {
    const run = this._chain.then(async () => {
      await this.ensureDir();
      const path = this.filePath(dateStr);
      let content = '';
      try {
        content = await readFile(path, 'utf-8');
      } catch {
        return { success: false, reason: 'Log file not found' };
      }

      const lines = content.split('\n');
      const idx = lines.findIndex(l => l.includes(oldRow) && !l.startsWith('| ~~'));
      if (idx === -1) return { success: false, reason: 'Entry not found' };

      lines[idx] = lines[idx].replace(/^\|/, '| ~~') + ' ~~';
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const newRow = `| ${time} | 回滚 | ${newDelta >= 0 ? '+' : ''}${newDelta} | ${sanitizeText(newReason.slice(0, 70))} | 已回滚 |`;
      lines.splice(idx + 1, 0, newRow);

      await atomicWrite(path, lines.join('\n'));
      return { success: true };
    });
    this._chain = run.catch(() => {});
    return run;
  }

  /** Map base emotion to its block name */
  static blockForBase(base) {
    return BASE_TO_BLOCK[base] || base;
  }
}