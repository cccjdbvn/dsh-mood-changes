/**
 * 运行参数（tuning）：思念/无聊的增速、衰减冷却、夜间窗口等（E19，2026-11-24 用户需求）
 *
 * 存在 `worldDir/mood/tuning.json`，改完**即时生效**（不重启插件）——设置页
 * 保存后调用 setTuning 更新内存，下一跳 tick 就用新值。文件不存在 = 全默认。
 *
 * 所有默认值等于原来写死在 lib/missing.js、lib/boredom.js 里的常量，
 * 不配 tuning.json 时行为与旧版完全一致。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_TUNING = {
  missing: {
    baseGrowth: 0.5,      // 每跳 +0.5
    nightFactor: 0.4,     // 夜间 ×0.4
    dropCooldownMs: 3600000, // 主人说话降值冷却 1h
    dropFactor: 0.8,      // 降值保留 80%
  },
  boredom: {
    baseGrowth: 4.5,      // 每跳 +4.5
    sameTypeCooldownMs: 3600000,  // 同类型冷却 1h
    crossTypeCooldownMs: 1800000, // 跨类型冷却 30min
    msgFactor: 0.7,
    toolFactor: 0.6,
    toolWindowMs: 3600000,
    toolSecondAt: 5,
  },
  night: {
    startHour: 23,
    endHour: 7,
  },
};

/** 设置页字段表：path 是 tuning 里的点路径；unit 决定设置页显示单位。
 *  分组顺序就是设置页里的分块顺序（2026-11-24 用户要求：增速一块、CD 一块）。 */
export const TUNING_FIELDS = [
  { group: '增速', path: 'missing.baseGrowth', label: '思念·每跳增速', unit: 'ratio', step: 0.1, description: '每 15 分钟一跳；默认 0.5' },
  { group: '增速', path: 'missing.nightFactor', label: '思念·夜间增速系数', unit: 'ratio', step: 0.1, description: '夜间窗口内增速乘这个数；默认 0.4' },
  { group: '增速', path: 'boredom.baseGrowth', label: '无聊·每跳增速', unit: 'ratio', step: 0.1, description: '每 15 分钟一跳；默认 4.5' },
  { group: '衰减', path: 'missing.dropFactor', label: '思念·降值系数', unit: 'ratio', step: 0.05, description: '主人说话后保留几成；默认 0.8' },
  { group: '衰减', path: 'boredom.msgFactor', label: '无聊·消息衰减系数', unit: 'ratio', step: 0.05, description: '收到消息后保留几成；默认 0.7' },
  { group: '衰减', path: 'boredom.toolFactor', label: '无聊·工具衰减系数', unit: 'ratio', step: 0.05, description: '做完事之后保留几成；默认 0.6' },
  { group: '冷却', path: 'missing.dropCooldownMs', label: '思念·降值冷却', unit: 'min', step: 1, description: '两次降值之间至少隔多久；默认 60 分钟' },
  { group: '冷却', path: 'boredom.sameTypeCooldownMs', label: '无聊·同类型冷却', unit: 'min', step: 1, description: '消息→消息 / 工具→工具；默认 60 分钟' },
  { group: '冷却', path: 'boredom.crossTypeCooldownMs', label: '无聊·跨类型冷却', unit: 'min', step: 1, description: '消息与工具之间；默认 30 分钟' },
  { group: '冷却', path: 'boredom.toolWindowMs', label: '无聊·工具窗口长度', unit: 'min', step: 1, description: '滚动统计窗口；默认 60 分钟' },
  { group: '冷却', path: 'boredom.toolSecondAt', label: '无聊·第几次工具调用追加衰减', unit: 'count', step: 1, description: '默认第 5 次' },
  { group: '夜间', path: 'night.startHour', label: '夜间开始（点）', unit: 'hour', step: 1, description: '默认 23；夜间不涨无聊、不掷骰、思念减速' },
  { group: '夜间', path: 'night.endHour', label: '夜间结束（点）', unit: 'hour', step: 1, description: '默认 7（不含）' },
];

const MULTIPLIER = { ratio: 1, count: 1, hour: 1, min: 60000 };

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_TUNING));
}

/** 旧 state/tuning 逐项回填默认值；非数字或超范围的值丢弃。 */
export function normalizeTuning(raw) {
  const out = cloneDefault();
  if (!raw || typeof raw !== 'object') return out;
  for (const field of TUNING_FIELDS) {
    const parts = field.path.split('.');
    let node = raw;
    for (const part of parts) node = node && typeof node === 'object' ? node[part] : undefined;
    if (typeof node !== 'number' || !Number.isFinite(node)) continue;
    let value = node;
    if (field.unit === 'hour' && (value < 0 || value > 23)) continue;
    if (field.unit === 'count' && value < 1) continue;
    if ((field.unit === 'min' || field.unit === 'ratio') && value < 0) continue;
    let target = out;
    for (let i = 0; i < parts.length - 1; i++) target = target[parts[i]];
    target[parts[parts.length - 1]] = value;
  }
  return out;
}

export async function loadTuning(worldDir) {
  try {
    const raw = await readFile(join(worldDir, 'mood', 'tuning.json'), 'utf-8');
    return normalizeTuning(JSON.parse(raw.replace(/^\uFEFF/, '')));
  } catch {
    return cloneDefault();
  }
}

export async function saveTuning(worldDir, tuning) {
  const normalized = normalizeTuning(tuning);
  const dir = join(worldDir, 'mood');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'tuning.json');
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  await rename(tmp, path);
  return normalized;
}

/** 夜间窗口判断：支持跨零点（默认 23:00 起、07:00 止）。 */
export function isNightHour(now, night) {
  const start = night?.startHour ?? 23;
  const end = night?.endHour ?? 7;
  const hour = new Date(now).getHours();
  if (start === end) return false;
  return start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

/** 读取点路径。 */
export function getPath(tuning, path) {
  let node = tuning;
  for (const part of path.split('.')) node = node && typeof node === 'object' ? node[part] : undefined;
  return node;
}

/** 设置点路径（返回新对象，不改原值）。 */
export function setPath(tuning, path, value) {
  const parts = path.split('.');
  const next = JSON.parse(JSON.stringify(tuning || DEFAULT_TUNING));
  let node = next;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  return next;
}

/** tuning → 设置页显示值（毫秒换算成分钟）。 */
export function toDisplay(tuning) {
  const out = {};
  for (const field of TUNING_FIELDS) {
    const value = getPath(tuning, field.path);
    out[field.path] = typeof value === 'number' ? value / (MULTIPLIER[field.unit] || 1) : 0;
  }
  return out;
}

/** 设置页显示值 → tuning（分钟换算成毫秒）；非法返回 { error }。 */
export function fromDisplay(display) {
  let tuning = cloneDefault();
  for (const field of TUNING_FIELDS) {
    if (!(field.path in (display || {}))) continue;
    const raw = display[field.path];
    const value = Number(raw);
    if (!Number.isFinite(value)) return { error: `${field.group}·${field.label} 必须是数字` };
    if (field.unit === 'hour' && (value < 0 || value > 23 || !Number.isInteger(value))) {
      return { error: `${field.group}·${field.label} 必须是 0–23 的整数` };
    }
    if (field.unit === 'count' && (value < 1 || !Number.isInteger(value))) {
      return { error: `${field.group}·${field.label} 必须是不小于 1 的整数` };
    }
    if ((field.unit === 'min' || field.unit === 'ratio') && value < 0) {
      return { error: `${field.group}·${field.label} 不能是负数` };
    }
    tuning = setPath(tuning, field.path, value * (MULTIPLIER[field.unit] || 1));
  }
  return { tuning };
}
