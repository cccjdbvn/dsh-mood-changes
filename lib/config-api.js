/**
 * 设置页数据接口（E19，2026-11-24 用户需求）
 *
 * 客户端设置界面的插件配置页不再自动生成，插件要自己往
 * `settings.plugins.tab` 注册一个 tab。设置页分三块数据：
 *
 *   1. 插件配置（profile 的 cordis.patch.yml，Loader Config）
 *      GET/POST /dsh-mood-changes/config   → 写入走 configEditor.edit()，会重启插件
 *   2. 运行参数（worldDir/mood/tuning.json）：思念/无聊增速、衰减系数、冷却、夜间窗口
 *      GET/POST /dsh-mood-changes/tuning   → 即时生效，不重启插件
 *   3. 情绪基线（worldDir/mood/baseline.json）
 *      GET/POST /dsh-mood-changes/baseline → 写文件，基线 watcher 自动同步
 *
 * 安全：只接受回环地址；POST 必须是 application/json；只认白名单键。
 */
import { TUNING_FIELDS, toDisplay, fromDisplay, getPath, normalizeTuning, saveTuning } from './tuning.js';

const BASE_KEYS = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust'];

export const CONFIG_FIELDS = [
  { group: '插件配置', key: 'worldDir', label: '世界目录', kind: 'string', description: '存放 state 和日志的目录；留空 = 插件不启动' },
  { group: '插件配置', key: 'targetWorkspaceDir', label: '她的工作目录', kind: 'string', description: '按目录自动认家：该目录下最新、未归档、活着的根会话就是她；留空 = 退回按会话 id' },
  { group: '插件配置', key: 'targetSessionId', label: '兜底会话 id', kind: 'string', description: '没配工作目录时才用它；留空 = 所有会话都算她的' },
  { group: '插件配置', key: 'ownerNames', label: '主人昵称', kind: 'list', description: '逗号分隔；思念只对这些昵称降（私聊）' },
  { group: '插件配置', key: 'judgeBaseUrl', label: '判官端点', kind: 'string', description: 'OpenAI 兼容端点，如 http://127.0.0.1:8000/v1' },
  { group: '插件配置', key: 'judgeModel', label: '判官模型', kind: 'string', description: 'vLLM 的模型路径或 served-model-name' },
  { group: '插件配置', key: 'judgeApiKey', label: '判官 API Key', kind: 'string', description: '可选，多数本地端点不需要' },
  { group: '插件配置', key: 'judgeContextPath', label: '判官语境文件', kind: 'string', description: '她是谁 / 误判纠偏笔记（Markdown）；留空 = 无语境' },
  { group: '插件配置', key: 'judgeTimeout', label: '判句超时（毫秒）', kind: 'number', description: '默认 6000' },
  { group: '插件配置', key: 'judgeTemperature', label: '判官温度', kind: 'number', description: '默认 0.3；压低能减少同一句话判出两种结果' },
  { group: '插件配置', key: 'tickIntervalMs', label: 'tick 间隔（毫秒）', kind: 'number', description: '默认 900000（15 分钟）' },
];

const FIELD_MAP = new Map(CONFIG_FIELDS.map(f => [f.key, f]));
const TUNING_PATH_SET = new Set(TUNING_FIELDS.map(f => f.path));

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readRequestBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isLoopback(req) {
  const addr = String(req.socket?.remoteAddress || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** 当前生效值 → JSON 安全值（Loader 的 !!js 表达式可能不是字符串/数字，兜底成空）。 */
function present(field, raw) {
  if (field.kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (field.kind === 'list') {
    return Array.isArray(raw) ? raw.map(String) : [];
  }
  return raw === undefined || raw === null || typeof raw === 'object' ? '' : String(raw);
}

/** 客户端提交值 → 配置值；非法返回 { error }。 */
function coerce(field, raw) {
  if (field.kind === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: '必须是数字' };
    return { value: n };
  }
  if (field.kind === 'list') {
    if (Array.isArray(raw)) return { value: raw.map(v => String(v).trim()).filter(Boolean) };
    if (typeof raw === 'string') return { value: raw.split(/[,，]/).map(s => s.trim()).filter(Boolean) };
    return { error: '必须是字符串列表' };
  }
  return { value: String(raw ?? '') };
}

/**
 * 注册设置页三条本机接口。
 * @param {object} ctx - 插件上下文（apply 的 ctx）
 * @param {object} options
 * @param {object} options.config - apply 收到的生效配置
 * @param {string} options.worldDir - 世界目录
 * @param {object} options.store - MoodStore（读写 baseline）
 * @param {Function} options.getTuning - 读取当前运行参数
 * @param {Function} options.setTuning - 保存后更新内存里的运行参数
 * @returns {Function[]} disposers
 */
export function registerSettingsRoutes(ctx, options = {}) {
  const { config, worldDir, store, getTuning, setTuning } = options;
  const webServer = ctx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[dsh-mood-changes] webServer not ready; settings API NOT registered');
    return [];
  }

  const editorAvailable = () => {
    const editor = ctx.get('configEditor');
    const entry = ctx.fiber?.entry;
    return Boolean(editor && typeof editor.edit === 'function' && entry);
  };

  const configValues = () => {
    const out = {};
    for (const field of CONFIG_FIELDS) out[field.key] = present(field, config?.[field.key]);
    return out;
  };

  /** 写盘会在 Loader 里重启插件：先回响应，下一拍再写。 */
  const applyEdit = (set, unset) => {
    const editor = ctx.get('configEditor');
    const entry = ctx.fiber?.entry;
    if (!editor || typeof editor.edit !== 'function' || !entry) {
      ctx.logger?.warn?.('[dsh-mood-changes] configEditor unavailable; settings not saved');
      return;
    }
    editor
      .edit(entry, (current) => {
        const next = { ...(current || {}) };
        for (const [key, value] of Object.entries(set)) next[key] = value;
        for (const key of unset) delete next[key];
        return next;
      })
      .catch((error) => {
        ctx.logger?.warn?.('[dsh-mood-changes] settings save failed:', error);
      });
  };

  /** 统一判准入 + 读 JSON body；返回 null 表示已经响应过。 */
  const readJsonBody = async (req, res) => {
    const contentType = String(req.headers?.['content-type'] || '');
    if (!contentType.includes('application/json')) {
      sendJson(res, 415, { ok: false, error: 'POST 需要 Content-Type: application/json' });
      return null;
    }
    try {
      return JSON.parse((await readRequestBody(req)) || '{}');
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON（${error?.message ?? error}）` });
      return null;
    }
  };

  // ── 1. 插件配置（profile cordis.patch.yml） ──
  const configHandler = async (req, res) => {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '设置接口只接受本机请求' });

    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        fields: CONFIG_FIELDS,
        values: configValues(),
        editable: editorAvailable(),
      });
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: `这个接口只接受 GET 与 POST（当前是 ${String(req.method ?? '?')}）` });
    }

    const payload = await readJsonBody(req, res);
    if (!payload) return undefined;

    const set = {};
    const unset = [];
    try {
      for (const [key, raw] of Object.entries(payload?.set && typeof payload.set === 'object' ? payload.set : {})) {
        const field = FIELD_MAP.get(key);
        if (!field) throw new Error(`未知配置项：${key}`);
        const converted = coerce(field, raw);
        if (converted.error) throw new Error(`${field.label}：${converted.error}`);
        set[key] = converted.value;
      }
      for (const key of Array.isArray(payload?.unset) ? payload.unset.map(String) : []) {
        const field = FIELD_MAP.get(key);
        if (!field) throw new Error(`未知配置项：${key}`);
        unset.push(key);
      }
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }

    if (Object.keys(set).length === 0 && unset.length === 0) {
      return sendJson(res, 400, { ok: false, error: '没有要改的内容（set 与 unset 都为空）' });
    }
    if (!editorAvailable()) {
      return sendJson(res, 409, { ok: false, error: '这个 profile 里没有可写入的配置入口（configEditor / fiber.entry 不可用）' });
    }

    const nextValues = { ...configValues() };
    for (const [key, value] of Object.entries(set)) nextValues[key] = present(FIELD_MAP.get(key), value);
    for (const key of unset) nextValues[key] = present(FIELD_MAP.get(key), undefined);

    sendJson(res, 200, { ok: true, restarting: true, values: nextValues });
    setTimeout(() => applyEdit(set, unset), 50);
    return undefined;
  };

  // ── 2. 运行参数（tuning.json，即时生效） ──
  const tuningHandler = async (req, res) => {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '设置接口只接受本机请求' });

    const current = normalizeTuning(getTuning?.() || null);

    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, fields: TUNING_FIELDS, values: toDisplay(current) });
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: `这个接口只接受 GET 与 POST（当前是 ${String(req.method ?? '?')}）` });
    }

    const payload = await readJsonBody(req, res);
    if (!payload) return undefined;

    const set = payload?.set && typeof payload.set === 'object' ? payload.set : {};
    const unknown = Object.keys(set).filter(path => !TUNING_PATH_SET.has(path));
    if (unknown.length) {
      return sendJson(res, 400, { ok: false, error: `未知运行参数：${unknown.join('、')}` });
    }
    if (Object.keys(set).length === 0) {
      return sendJson(res, 400, { ok: false, error: '没有要改的内容（set 为空）' });
    }

    const merged = { ...toDisplay(current), ...set };
    const converted = fromDisplay(merged);
    if (converted.error) return sendJson(res, 400, { ok: false, error: converted.error });

    try {
      await saveTuning(worldDir, converted.tuning);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: `运行参数写入失败（${error?.message ?? error}）` });
    }
    setTuning?.(converted.tuning);
    return sendJson(res, 200, { ok: true, fields: TUNING_FIELDS, values: toDisplay(converted.tuning) });
  };

  // ── 3. 情绪基线（baseline.json，写文件后 watcher 自动同步） ──
  const baselineHandler = async (req, res) => {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '设置接口只接受本机请求' });

    if (req.method === 'GET') {
      let values = {};
      try { values = await store.loadBaseline(); } catch { values = {}; }
      return sendJson(res, 200, { ok: true, values });
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: `这个接口只接受 GET 与 POST（当前是 ${String(req.method ?? '?')}）` });
    }

    const payload = await readJsonBody(req, res);
    if (!payload) return undefined;

    const input = payload?.values && typeof payload.values === 'object' ? payload.values : null;
    if (!input) return sendJson(res, 400, { ok: false, error: '缺少 values（六情基线对象）' });

    const next = {};
    for (const key of BASE_KEYS) {
      const value = Number(input[key]);
      if (!Number.isFinite(value)) return sendJson(res, 400, { ok: false, error: `${key} 必须是数字` });
      if (value < 0 || value > 100) return sendJson(res, 400, { ok: false, error: `${key} 必须在 0–100 之间` });
      next[key] = value;
    }

    try {
      await store.saveBaseline(next);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: `基线写入失败（${error?.message ?? error}）` });
    }
    return sendJson(res, 200, { ok: true, values: next });
  };

  const disposers = [];
  const register = (path, handler) => {
    try {
      disposers.push(webServer.register({ kind: 'exact', path, handler }));
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-mood-changes] settings route ${path} registration error:`, error);
    }
  };
  register('/dsh-mood-changes/config', configHandler);
  register('/dsh-mood-changes/tuning', tuningHandler);
  register('/dsh-mood-changes/baseline', baselineHandler);
  return disposers;
}
