import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_DIR = 'room';
const LOG_SUBDIR = '情绪日志';

const BASE_TO_BLOCK = { happy: '乐', sad: '悲', anger: '怒', fear: '惧', surprise: '惊', disgust: '厌' };
const BLOCK_TO_BASE = { '乐': 'happy', '悲': 'sad', '怒': 'anger', '惧': 'fear', '惊': 'surprise', '厌': 'disgust' };

const HEADER_ROW = '| 时间 | 情绪 | 变化 | 原因 | 状态 | 生效 |';
const SEP_ROW = '|---|---|---|---|---|---|';

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
 * Daily Markdown log. Six columns:
 *   时间 = 记录时间（判句时刻，反查原因用）
 *   生效 = 结算时刻（衰减起点 = 下一次自动核算的时间；A7 回滚按它重放）
 *无聊/思念/状态/传播行即时生效，生效列 = 时间列。
 *
 * All writes go through an internal promise chain (A2). appendBatch() writes
 * several rows for one event in a single read-modify-write.
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
   * Cutoff is 04:00 local time. Uses LOCAL date parts (A1).
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
   * @param {object} entry - { ts, block, emotion, delta, origDelta?, reason, stateNote?, effectiveAt? }
   *   delta: the effective value (after modifiers). origDelta: raw value before
   *   modifiers, written as （原 X） when present and different.
   *   effectiveAt: settlement time (decay start). Defaults to ts.
   */
  async append(entry) {
    const run = this._chain.then(() => this._appendNow(entry));
    this._chain = run.catch(() => {});
    return run;
  }

  /**
   * Append several entries in one serialized read-modify-write per date file.
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
      return `# ${dateStr} 情绪日志\n\n> 六列：时间=记录（判句）｜情绪｜变化=最终生效值（修饰时括注原值）｜原因｜状态｜生效=衰减起点（结算时刻）。\n`;
    }
  }

  _formatRow(entry) {
    const time = hhmm(entry.ts);
    const effective = hhmm(entry.effectiveAt ?? entry.ts);
    const label = sanitizeText(entry.emotion || '');
    let deltaStr;
    if (entry.origDelta !== undefined && entry.origDelta !== entry.delta) {
      deltaStr = `${entry.delta >= 0 ? '+' : ''}${entry.delta}（原 ${entry.origDelta}）`;
    } else {
      deltaStr = `${entry.delta >= 0 ? '+' : ''}${entry.delta}`;
    }
    const reason = sanitizeText((entry.reason || '').slice(0, 70));
    const stateCol = sanitizeText(entry.stateNote || '—');
    return `| ${time} | ${label} | ${deltaStr} | ${reason} | ${stateCol} | ${effective} |`;
  }

  /**
   * Insert entry's row into the correct block, keeping rows sorted by the
   * 生效 column (settlement order). Returns updated content.
   */
  _insertRowFor(entry, content) {
    const row = this._formatRow(entry);
    const sortKey = hhmm(entry.effectiveAt ?? entry.ts);
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
        // Sort by the 生效 column (index 5). Rows share the "| ... |" shape.
        tableLines.sort((a, b) => effOf(a).localeCompare(effOf(b)));
        for (const tl of tableLines) result.push(tl);
        while (j < lines.length) result.push(lines[j++]);
        return result.join('\n');
      }
    }

    // Block doesn't exist yet: append it at the end.
    result.push('', blockHeader, '', HEADER_ROW, SEP_ROW, row);
    return result.join('\n');
  }

  /**
   * Read log entries for a date, optionally filtered by block.
   * Each entry carries both times (time = record, effective = decay start).
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
      if (cols.length < 5) continue;

      const deltaMatch = String(cols[2] || '').match(/[+-][\d.]+/);
      entries.push({
        block: currentBlock,
        time: cols[0] || '',
        emotion: cols[1] || '',
        delta: deltaMatch ? parseFloat(deltaMatch[0]) : 0,
        reason: cols[3] || '',
        state: cols[4] || '',
        effective: cols[5] || cols[0] || '',
        raw: trimmed
      });
    }
    return entries;
  }

  /**
   * A7 numeric rollback — ledger part.
   * Marks the matched row (and its same-instant propagation rows) as rolled
   * back, writes a replacement row. The numeric side (replaying decay) lives
   * in the tool layer; this method returns the matched entries so the caller
   * can compute corrections.
   * @param {string} dateStr - file date
   * @param {string} time - HH:MM of the 时间 column
   * @param {string} block - block name (乐/悲/怒/惧/惊/厌/思念/无聊)
   * @param {object} replacement - { note, newDelta } for the replacement row
   * @returns {Promise<{success: boolean, reason?: string, entries?: object[]}>}
   *   entries: the main row + propagation rows that were struck out.
   */
  async rollback(dateStr, time, block, replacement = {}) {
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
      const blockHeader = block === '状态' ? '## 状态' : `## ${block}`;
      let inBlock = false;
      let blockIdx = -1;

      // Pass 1: find the main row (exact time match in the target block).
      // E6 (2026-11-23 夜): skip 回滚 replacement rows — they share the time
      // column with the verdict rows written in the same minute, and a
      // rollback once consumed a replacement row instead of the intended
      // verdict (log 22:52: struck the 22:50 replacement, needed a second
      // call to reach the real main row). Replacements are never targets.
      let mainIdx = -1;
      let mainEffective = null;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('## ')) { inBlock = trimmed === blockHeader; if (inBlock) blockIdx = i; continue; }
        if (!inBlock || !trimmed.startsWith('| ') || trimmed.startsWith('| ~~')) continue;
        const cols = trimmed.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length < 5) continue;
        if (cols[1] === '回滚') continue; // replacement rows are not rollback targets
        if (cols[0] === time) {
          mainIdx = i;
          mainEffective = cols[5] || cols[0];
          break;
        }
      }
      if (mainIdx === -1) return { success: false, reason: `在「${block}」块里没找到时间为 ${time} 的可回滚行（回滚替换行不算目标）` };

      // Pass 2: same-instant propagation rows in ANY six-affect block whose
      // reason is 由<parent block>传播 — they cascade with the source.
      // (Compare ignoring whitespace: rows write "由 悲 传播".)
      const parentLabel = `由${block}传播`.replace(/\s/g, '');
      const struck = [];
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed.startsWith('| ') || trimmed.startsWith('| ~~')) continue;
        if (i === mainIdx) continue;
        const cols = trimmed.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length < 5) continue;
        const effective = cols[5] || cols[0];
        if (effective === mainEffective && String(cols[3] || '').replace(/\s/g, '') === parentLabel) {
          struck.push(i);
        }
      }

      // Collect the full entries before striking (for numeric replay).
      const collect = (idx) => {
        const cols = lines[idx].split('|').map(c => c.trim()).filter(Boolean);
        const deltaMatch = String(cols[2] || '').match(/[+-][\d.]+/);
        let blk = null;
        for (let j = idx; j >= 0; j--) {
          const t = lines[j].trim();
          if (t.startsWith('## ')) { blk = t.slice(3).trim(); break; }
        }
        return {
          block: blk,
          time: cols[0] || '',
          emotion: cols[1] || '',
          delta: deltaMatch ? parseFloat(deltaMatch[0]) : 0,
          reason: cols[3] || '',
          effective: cols[5] || cols[0],
          raw: lines[idx]
        };
      };
      const mainEntry = collect(mainIdx);
      const propEntries = struck.map(collect);

      // Strike out the rows.
      lines[mainIdx] = lines[mainIdx].replace(/^\|/, '| ~~') + ' ~~';
      for (const idx of struck) {
        lines[idx] = lines[idx].replace(/^\|/, '| ~~') + ' ~~';
      }

      // Replacement row (marked 已回滚, both times = now).
      const now = new Date();
      const nowTime = hhmm(now.getTime());
      const newDelta = replacement.newDelta ?? 0;
      const cascadeNote = struck.length > 0 ? `，连带 ${struck.length} 笔传播` : '';
      const newRow = `| ${nowTime} | 回滚 | ${newDelta >= 0 ? '+' : ''}${newDelta} | ${sanitizeText((replacement.note || '').slice(0, 70))} | 已回滚（原 ${time}${cascadeNote}） | ${nowTime} |`;
      // Insert right after the main row's block header table — append after struck rows.
      lines.splice(mainIdx + 1, 0, newRow);

      await atomicWrite(path, lines.join('\n'));
      return { success: true, entries: [mainEntry, ...propEntries] };
    });
    this._chain = run.catch(() => {});
    return run;
  }

  /** Map base emotion to its block name */
  static blockForBase(base) {
    return BASE_TO_BLOCK[base] || base;
  }

  /** Map block name to base emotion (A7 rollback) */
  static baseForBlock(block) {
    return BLOCK_TO_BASE[block] || null;
  }
}

function hhmm(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 生效 column of a raw table row (index 5, fallback 0). */
function effOf(rawLine) {
  const cols = rawLine.split('|').map(c => c.trim()).filter(Boolean);
  return cols[5] || cols[0] || '';
}