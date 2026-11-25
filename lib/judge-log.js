import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MoodLog } from './log.js';

const JUDGE_DIR = 'judge-log';

/**
 * 判官判定记录（E26，2026-11-25 用户需求）
 *
 * 情绪日志只记「变了什么」：判官判了「这轮没有引起情绪变化」、判出的强度没过门槛、
 * 调用失败、返回解析不出来 —— 这些在 .md 里一个字都不留。于是「消息到底进没进
 * 判官」只能靠翻 vLLM 的日志去猜（2026-11-25 凌晨就为此查了半小时）。
 *
 * 这个文件补的就是这件事：**每次判官调用的输入与结果都落一行**，不管最后有没有
 * 写进情绪值、有没有触发状态。
 *
 * 位置：`<worldDir>/mood/judge-log/YYYY-MM-DD.jsonl`（按 04:00 切天，与情绪日志同规则）
 * 格式：一行一条 JSON，便于 grep / jq / 事后回放，不必解析表格。
 * 不参与任何计算：写失败只 warn，不影响判句本身。
 */
export class JudgeLog {
  constructor(worldDir) {
    this.worldDir = worldDir;
    this._chain = Promise.resolve();
  }

  logDir() {
    return join(this.worldDir, 'mood', JUDGE_DIR);
  }

  filePath(dateStr) {
    return join(this.logDir(), `${dateStr}.jsonl`);
  }

  /** 追加一条记录。串行化，可 fire-and-forget。 */
  append(record) {
    const run = this._chain.then(async () => {
      await mkdir(this.logDir(), { recursive: true });
      const dateStr = MoodLog.dateFor(record.at ?? Date.now());
      await appendFile(this.filePath(dateStr), JSON.stringify(record) + '\n', 'utf-8');
    });
    this._chain = run.catch(() => {});
    return run;
  }

  /** 读某天的记录（工具与测试用）。文件不存在返回空数组。 */
  async read(dateStr) {
    try {
      const raw = await readFile(this.filePath(dateStr), 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
    } catch {
      return [];
    }
  }
}
