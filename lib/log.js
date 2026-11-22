import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_DIR = 'room';
const LOG_SUBDIR = '情绪日志';

const BLOCK_NAMES = ['乐', '悲', '怒', '惧', '惊', '厌', '思念', '无聊'];

const BASE_TO_BLOCK = { happy: '乐', sad: '悲', anger: '怒', fear: '惧', surprise: '惊', disgust: '厌' };

/**
 * Daily Markdown log: eight blocks (six emotions + missing + boredom) + state block.
 */
export class MoodLog {
  constructor(worldDir) {
    this.worldDir = worldDir;
  }

  logDir() {
    return join(this.worldDir, LOG_DIR, LOG_SUBDIR);
  }

  async ensureDir() {
    await mkdir(this.logDir(), { recursive: true });
  }

  /**
   * Get the log file path for a given date (local date string YYYY-MM-DD).
   * Events before 04:00 belong to the previous day.
   */
  filePath(dateStr) {
    return join(this.logDir(), `${dateStr}.md`);
  }

  /**
   * Determine the log date for a timestamp.
   * Cutoff is 04:00 local time.
   */
  static dateFor(ts) {
    const d = new Date(ts);
    if (d.getHours() < 4) {
      d.setDate(d.getDate() - 1);
    }
    return d.toISOString().slice(0, 10);
  }

  /**
   * Append an entry to the daily log.
   * @param {object} entry
   * @param {number} entry.ts - timestamp
   * @param {string} entry.block - block name (乐/悲/怒/惧/惊/厌/思念/无聊) or '状态'
   * @param {string} entry.emotion - emotion label
   * @param {number} entry.delta - signed change
   * @param {string} entry.reason - ≤70 char reason
   * @param {string} entry.state - optional state modifier text
   */
  async append(entry) {
    await this.ensureDir();
    const dateStr = MoodLog.dateFor(entry.ts);
    const path = this.filePath(dateStr);

    let content = '';
    try {
      content = await readFile(path, 'utf-8');
    } catch {
      content = `# ${dateStr} 情绪日志\n\n> 八块固定顺序：乐 / 悲 / 怒 / 惧 / 惊 / 厌 / 思念 / 无聊；最后一块「状态」记状态触发。\n`;
    }

    const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const label = entry.emotion || '';
    const deltaStr = entry.state
      ? `${entry.delta >= 0 ? '+' : ''}${entry.delta}（${entry.state}）`
      : `${entry.delta >= 0 ? '+' : ''}${entry.delta}`;
    const reason = (entry.reason || '').slice(0, 70);
    const stateCol = entry.stateNote || '—';

    const row = `| ${time} | ${label} | ${deltaStr} | ${reason} | ${stateCol} |`;

    // Insert row in correct block
    const blockHeader = entry.block === '状态' ? '## 状态' : `## ${entry.block}`;
    const lines = content.split('\n');
    let inserted = false;
    const result = [];

    for (let i = 0; i < lines.length; i++) {
      result.push(lines[i]);
      if (lines[i].trim() === blockHeader) {
        // Skip the header row of the table if present
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === '' || lines[j].startsWith('| 时间') || lines[j].startsWith('|---'))) {
          if (lines[j].trim() === '') { result.push(''); j++; continue; }
          result.push(lines[j]);
          j++;
        }
        // Insert the row in chronological order
        const tableLines = [];
        while (j < lines.length && lines[j].startsWith('|')) {
          tableLines.push(lines[j]);
          j++;
        }
        // Insert our row in order
        tableLines.push(row);
        tableLines.sort(); // Time-sorted by HH:MM
        for (const tl of tableLines) result.push(tl);
        // Push remaining lines
        while (j < lines.length) result.push(lines[j++]);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      // Block doesn't exist yet, append it
      result.push('', blockHeader, '', '| 时间 | 情绪 | 变化 | 原因 | 状态 |', '|---|---|---|---|---|', row);
    }

    await writeFile(path, result.join('\n'), 'utf-8');
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

  /** Roll back: mark an entry as rolled back and write the replacement */
  async rollback(dateStr, oldRow, newDelta = 0, newReason = '') {
    const path = this.filePath(dateStr);
    let content = '';
    try {
      content = await readFile(path, 'utf-8');
    } catch {
      return { success: false, reason: 'Log file not found' };
    }

    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.includes(oldRow));
    if (idx === -1) return { success: false, reason: 'Entry not found' };

    // Mark original as rolled back
    lines[idx] = lines[idx].replace(/^\|/, '| ~~') + ' ~~';
    // Add replacement row after
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const newRow = `| ${time} | 回滚 | ${newDelta >= 0 ? '+' : ''}${newDelta} | ${newReason.slice(0, 70)} | 已回滚 |`;
    lines.splice(idx + 1, 0, newRow);

    await writeFile(path, lines.join('\n'), 'utf-8');
    return { success: true };
  }

  /** Map base emotion to its block name */
  static blockForBase(base) {
    return BASE_TO_BLOCK[base] || base;
  }
}