/**
 * dsh-mood-changes（Mood changes） —— 汐涟的情绪插件
 *
 * 规则照作者的「情绪插件-参数稿 / 实现说明」两份文件；这里不自己发挥。
 *
 * 只敲门，不替人说话：注入出去的全是状态，没有一句台词。
 * 不碰 dsh-world、规矩本、日记、条目库；只读 life.json 里的 homeSessionId。
 */
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const SIX = ['happy', 'sad', 'fear', 'anger', 'surprise', 'disgust']
const ALL = [...SIX, 'missing', 'boredom']
const CN = {
  happy: '开心',
  sad: '悲伤',
  fear: '害怕',
  anger: '生气',
  surprise: '惊讶',
  disgust: '厌恶',
  missing: '思念',
  boredom: '无聊',
}
const INDEX = Object.fromEntries(SIX.map((key, i) => [key, i]))

/** 参数稿八：六情三档 0–5 / 5–25 / 25–30；三档触发主动核算。思念的 10–15 不触发。 */
const THIRD_FROM = 25
/** 参数稿七：思念 80 起不掷、直接提醒（第三档），30 起才掷。 */
const MISSING_DIRECT_FROM = 80
const MISSING_ROLL_FROM = 30
/** 参数稿五：常用组合名，六个两两一共 15 组。三个以上亮起按最亮的两条取。 */
const PAIR_NAMES = {
  'happy+sad': '悲喜交加',
  'happy+anger': '又好气又好笑',
  'happy+fear': '喜忧参半',
  'happy+surprise': '惊喜',
  'happy+disgust': '勉强高兴',
  'sad+anger': '悲愤',
  'sad+fear': '惶恐悲哀',
  'sad+surprise': '错愕心酸',
  'sad+disgust': '嫌弃又难过',
  'anger+fear': '敢怒不敢言',
  'anger+surprise': '吃惊发怒',
  'anger+disgust': '憎恶',
  'fear+surprise': '惊骇',
  'fear+disgust': '忌惮',
  'surprise+disgust': '愕然反感',
}

/** 参数表。定制改 patch 里那一张；这里的默认值跟参数稿对齐。 */
const DEFAULTS = {
  /** 空 = <DSH_HOME>/mood（DSH_HOME 没有就用 ~/.dsh） */
  dataDir: '',
  /** 填了 world 的 id，房间和 life.json 就照它推出来；空 = 不接世界，只显示状态 */
  worldId: '',
  /** 空 = <DSH_HOME>/worlds/<worldId>/room */
  roomDir: '',
  /** 空 = <DSH_HOME>/worlds/<worldId>/life.json */
  lifeFile: '',
  /** 留空就跟着 life.json 的 homeSessionId 走；填了就认填的那个。 */
  sessionId: '',
  sweepEveryMinutes: 15,
  nightStart: 23,
  nightEnd: 7,
  nightMultiplier: 0.4,
  decimals: 1,
  /** 思念一天的手动加分上限；六情不封顶。 */
  manualDailyCap: 40,
  joyHalfLifeHours: 5,
  sadHalfLifeHours: 10,
  fearHalfLifeHours: 12,
  angerHalfLifeHours: 6,
  surpriseHalfLifeHours: 2.5,
  disgustHalfLifeHours: 30,
  capHigh: 100,
  capNormal: 100,
  lightUpAt: 40,
  calmBelow: 20,
  nearGap: 5,
  rollEveryMinutes: 45,
  rollCooldownMinutes: 60,
  injectGapMinutes: 60,
  activeCooldownMinutes: 10,
  pollSeconds: 30,
  boredomPerHour: 6,
  boredomDropFactor: 0.5,
  boredomDropCooldownMinutes: 60,
  boredomRollFrom: 50,
  boredomDirectFrom: 80,
}

/** 乐的积分变换（参数稿附录，2026-11-18 下午换的）：F(0)=0，F'(0)=1/3，F(100)=∞。 */
const JOY_MAX = 99.9
const joyF = (x) => {
  const v = Math.min(JOY_MAX, Math.max(0, x))
  return (47 * v) / 165 + (578 / 33) * Math.log(1 - v / 100) + (246 / 11) * (v / (100 - v))
}
/** 反解没有闭式，二分。区间 [x, 99.9]，60 次就够。 */
function joyAdd(x, a) {
  const target = joyF(x) + a
  if (joyF(JOY_MAX) <= target) return JOY_MAX
  let lo = Math.min(JOY_MAX, Math.max(0, x))
  let hi = JOY_MAX
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2
    if (joyF(mid) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** 思念和无聊共用这条概率曲线（参数稿七、七之二）。 */
const rollChance = (x) => 1 / (Math.exp(6.25 - 0.1 * x) + 1)

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
function localIso(d) {
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hh = pad(Math.floor(Math.abs(offset) / 60))
  const mm = pad(Math.abs(offset) % 60)
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`
}

/** 定时器用 ctx.interval / ctx.timeout，得先把 timer 声明成依赖。 */
export const inject = ['timer']

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS }
  for (const [key, value] of Object.entries(rawConfig ?? {})) {
    if (key === 'sessionId') {
      cfg.sessionId = value == null ? '' : String(value)
      continue
    }
    if (value === undefined || value === null || value === '') continue
    cfg[key] = value
  }

  // 路径：能配就听配置，没配就从 DSH_HOME 推；world 相关的两样靠 worldId
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const worldId = String(cfg.worldId ?? '').trim()
  const dataDir = cfg.dataDir ? String(cfg.dataDir) : join(dshHome, 'mood')
  const roomDir = cfg.roomDir
    ? String(cfg.roomDir)
    : worldId
      ? join(dshHome, 'worlds', worldId, 'room')
      : ''
  const lifeFile = cfg.lifeFile
    ? String(cfg.lifeFile)
    : worldId
      ? join(dshHome, 'worlds', worldId, 'life.json')
      : ''
  const statePath = join(dataDir, 'state.json')
  const logPath = join(dataDir, 'mood.log')
  const plusPath = roomDir ? join(roomDir, '情绪-加分.txt') : undefined
  const settlePath = roomDir ? join(roomDir, '情绪-核算.now') : undefined
  const actPath = roomDir ? join(roomDir, '情绪-做事.now') : undefined

  const decimals = Math.max(0, Math.min(6, Number(cfg.decimals) || 0))
  const unit = Math.pow(10, decimals)
  const round = (value) => Math.round(value * unit) / unit
  const fmt = (value) => round(value).toFixed(decimals)
  const minute = 60 * 1000
  const sweepMs = Math.max(1, Number(cfg.sweepEveryMinutes) || 15) * minute
  const pollMs = Math.max(1, Number(cfg.pollSeconds) || 30) * 1000
  const clock = () => Date.now()

  let stopped = false
  let ticking = false
  let settling = false
  let lastTickAt = 0
  let lastInjectAt = 0
  let lastActiveAt = 0
  let lastCoolLogAt = 0
  let lastDropAt = { missing: 0, boredom: 0 }
  let lastNotifyAt = { missing: 0, boredom: 0 }
  let manualDay = ''
  let manualSum = 0
  let values = Object.fromEntries(ALL.map((key) => [key, 0]))
  let lifeCache = { mtime: -1, id: undefined }

  function log(message) {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, `${localIso(new Date())} ${message}\n`)
    } catch {
      // 日志写不进去不该拖垮插件
    }
  }

  // ── 状态文件 ────────────────────────────────────────────────

  function resetState() {
    values = Object.fromEntries(ALL.map((key) => [key, 0]))
    lastTickAt = clock()
    lastInjectAt = 0
    lastActiveAt = 0
    lastDropAt = { missing: 0, boredom: 0 }
    lastNotifyAt = { missing: 0, boredom: 0 }
    manualDay = localDate(new Date())
    manualSum = 0
  }

  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))

  function loadState() {
    resetState()
    if (!existsSync(statePath)) return
    let parsed
    try {
      parsed = readJson(statePath)
      if (!parsed || typeof parsed !== 'object') throw new Error('不是对象')
    } catch (error) {
      const broken = `${statePath}.broken-${localIso(new Date()).replace(/[:.]/g, '-')}`
      try {
        renameSync(statePath, broken)
      } catch {
        // 备份失败就照原样放着，不在日志里假装备份过
      }
      resetState()
      log(`state.json 读不动（${error.message}），已备份成 ${broken}，从零起`)
      return
    }
    if (parsed.values && typeof parsed.values === 'object') {
      for (const key of ALL) {
        const value = Number(parsed.values[key])
        values[key] = Number.isFinite(value) ? value : 0
      }
    }
    if (Number.isFinite(Number(parsed.lastTickAt))) lastTickAt = Number(parsed.lastTickAt)
    if (Number.isFinite(Number(parsed.lastInjectAt))) lastInjectAt = Number(parsed.lastInjectAt)
    if (Number.isFinite(Number(parsed.lastActiveAt))) lastActiveAt = Number(parsed.lastActiveAt)
    for (const key of ['missing', 'boredom']) {
      const drop = Number(parsed.lastDropAt?.[key])
      const notify = Number(parsed.lastNotifyAt?.[key])
      if (Number.isFinite(drop)) lastDropAt[key] = drop
      if (Number.isFinite(notify)) lastNotifyAt[key] = notify
    }
    if (typeof parsed.manualDay === 'string') manualDay = parsed.manualDay
    if (Number.isFinite(Number(parsed.manualSum))) manualSum = Number(parsed.manualSum)
  }

  function saveState() {
    const out = {
      values: Object.fromEntries(ALL.map((key) => [key, round(values[key])])),
      lastTickAt,
      lastInjectAt,
      lastActiveAt,
      lastDropAt,
      lastNotifyAt,
      manualDay,
      manualSum: round(manualSum),
    }
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify(out, null, 2)}\n`)
  }

  // ── 数值 ────────────────────────────────────────────────────

  function nightNow(now) {
    const hour = new Date(now).getHours()
    const start = Number(cfg.nightStart)
    const end = Number(cfg.nightEnd)
    return start <= end ? hour >= start && hour < end : hour >= start || hour < end
  }

  function capOf(key) {
    if (key === 'happy') return JOY_MAX
    if (key === 'missing' || key === 'boredom') return 100
    return key === 'disgust' ? Number(cfg.capNormal) : Number(cfg.capHigh)
  }

  function clampAll() {
    for (const key of ALL) {
      values[key] = Math.min(capOf(key), Math.max(0, values[key]))
    }
  }

  const keepFactor = (hours) => Math.pow(0.5, 0.25 / Math.max(0.01, hours))
  const halfLife = {
    happy: () => Number(cfg.joyHalfLifeHours),
    sad: () => Number(cfg.sadHalfLifeHours),
    fear: () => Number(cfg.fearHalfLifeHours),
    anger: () => Number(cfg.angerHalfLifeHours),
    surprise: () => Number(cfg.surpriseHalfLifeHours),
    disgust: () => Number(cfg.disgustHalfLifeHours),
  }

  /** 参数稿四：先乘衰减系数，再加增量，最后封顶；低于 0.05 归零。只在定时那趟调。 */
  function decaySix() {
    for (const key of SIX) {
      const k = keepFactor(halfLife[key]())
      let value = values[key] * k
      if (value < 0.05) value = 0
      values[key] = value
    }
  }

  /** 参数稿三：只有 happy 的正增量走积分；其余（含 happy 的负值）直接在 x 上加减。 */
  function applyDeltas(deltas) {
    const today = localDate(new Date())
    if (manualDay !== today) {
      manualDay = today
      manualSum = 0
    }
    for (const key of ALL) {
      const delta = deltas[key]
      if (!delta) continue
      if (key === 'happy' && delta > 0) {
        values.happy = joyAdd(values.happy, delta)
        continue
      }
      if (delta < 0) {
        values[key] = Math.max(0, values[key] + delta)
        continue
      }
      let add = delta
      if (key === 'missing') {
        const remain = Math.max(0, Number(cfg.manualDailyCap) - manualSum)
        add = Math.min(add, remain)
        manualSum += add
      }
      values[key] += add
    }
  }

  // ── 加分队列 ────────────────────────────────────────────────

  function readQueue(fn) {
    if (!plusPath || !existsSync(plusPath)) return undefined
    let content
    try {
      content = readFileSync(plusPath, 'utf8')
    } catch (error) {
      log(`加分文件读不动：${error.message}`)
      return undefined
    }
    return fn(content)
  }

  /** 只看不动：文件里有没有第三档（六情 25–30 那一档）。 */
  function hasThirdTier() {
    return (
      readQueue((content) =>
        content.split(/\r?\n/).some((raw) => {
          const line = raw.trim()
          if (!line || line.startsWith('#')) return false
          const match = /^([a-z]+)([+-]\d+(?:\.\d+)?)$/.exec(line.replace(/\s+/g, ''))
          if (!match) return false
          const key = match[1]
          if (!SIX.includes(key)) return false
          return Math.abs(Number(match[2])) >= THIRD_FROM
        }),
      ) === true
    )
  }

  /** 吃队列：读、清空、返回增量（两趟共用这一半）。冷却挡下时不许调它。 */
  function collect() {
    const deltas = {}
    readQueue((content) => {
      for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const match = /^([a-z]+)([+-]\d+(?:\.\d+)?)$/.exec(line.replace(/\s+/g, ''))
        if (!match) {
          log(`加分文件里这行解析不了，丢了：${line}`)
          continue
        }
        const key = match[1]
        const delta = Number(match[2])
        if (!ALL.includes(key)) {
          log(`加分文件里没有这个情绪名，丢了：${line}`)
          continue
        }
        if (key === 'boredom') {
          log(`无聊不可手动写入，丢了：${line}`)
          continue
        }
        if (!Number.isFinite(delta)) continue
        deltas[key] = (deltas[key] ?? 0) + delta
      }
      try {
        writeFileSync(plusPath, '')
      } catch (error) {
        log(`加分文件清空失败（下一跳会重复吃）：${error.message}`)
      }
      return true
    })
    return deltas
  }

  // ── 判定与注入 ──────────────────────────────────────────────

  const pairName = (list) => {
    const keys = [...list].map((item) => item.key).sort((a, b) => INDEX[a] - INDEX[b])
    return PAIR_NAMES[keys.join('+')] ?? keys.map((key) => CN[key]).join('＋')
  }

  const detail = (list) => list.map((item) => `${CN[item.key]} ${fmt(item.v)}`).join(' / ')

  const litList = () =>
    SIX.filter((key) => values[key] > Number(cfg.lightUpAt)).map((key) => ({ key, v: values[key] }))

  function nameFor(list) {
    if (list.length <= 1) return list.map((item) => CN[item.key]).join('') || '平静'
    const brightest = [...list].sort((a, b) => b.v - a.v).slice(0, 2)
    return pairName(brightest)
  }

  /** 亮起才投；名字和数值，别的都不加。 */
  function moodText() {
    const lit = litList()
    if (lit.length === 0) return undefined
    return `【情绪】${nameFor(lit)}（${detail(lit)}）`
  }

  /** 一句话说清此刻：亮起报名字（最亮两条取名），没亮报「平静」或最高的那一条。 */
  function describeState() {
    const lit = litList()
    if (lit.length > 0) {
      return { label: nameFor(lit), lit: lit.map((item) => item.key), detail: detail(lit), steady: false }
    }
    const sorted = SIX.map((key) => ({ key, v: values[key] })).sort((a, b) => b.v - a.v)
    const top = sorted[0]
    const topDetail = `${CN[top.key]} ${fmt(top.v)}`
    if (top.v < Number(cfg.calmBelow)) return { label: '平静', lit: [], detail: topDetail, steady: true }
    return { label: CN[top.key], lit: [], detail: topDetail, steady: false }
  }

  /** 状态一句话，只进日志。 */
  function stateLine() {
    const state = describeState()
    if (state.lit.length > 0) return `${state.label}（${state.detail}）`
    if (state.steady) return `平静（${state.detail}）`
    return state.detail
  }

  const valuesLine = () =>
    ALL.filter((key) => values[key] > 0)
      .map((key) => `${CN[key]}${fmt(values[key])}`)
      .join(' ') || '全零'

  /** 现读 life.json；读不到就重试一次，还读不到返回 undefined（不编、不拿上次的顶上）。 */
  function readHomeSessionId() {
    const file = lifeFile
    if (!file) return undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const mtime = statSync(file).mtimeMs
        if (lifeCache.mtime === mtime) return lifeCache.id
        const parsed = readJson(file)
        const id = typeof parsed?.homeSessionId === 'string' && parsed.homeSessionId ? parsed.homeSessionId : undefined
        lifeCache = { mtime, id }
        return id
      } catch (error) {
        if (attempt === 1) log(`life.json 读不动（${error?.message ?? error}），这一跳不投`)
      }
    }
    return undefined
  }

  const resolveSessionId = () => (cfg.sessionId ? String(cfg.sessionId) : readHomeSessionId())

  async function say(text) {
    const sessionId = resolveSessionId()
    if (!sessionId) return false
    const agents = ctx.get('agents')
    let agent = agents?.get?.(sessionId)
    if (!agent) {
      // 会话冷着就按实现说明那条路唤一下：sessionController.resolveAgent
      const resolved = await ctx.get('sessionController')?.resolveAgent?.(sessionId)
      agent = resolved?.agent
    }
    if (!agent) {
      log(`会话 ${sessionId} 没醒过来，这条没发出去：${text}`)
      return false
    }
    // source.kind 标成自己，这一条才不会被当成「他来说话」去扣思念。
    // 这个名字刻意留着旧的 'mood-lian'：参数稿和实现说明都按它写的，而且历史里那几条也是它。
    const message = Object.freeze({
      role: 'user',
      content: Object.freeze([{ type: 'text', text }]),
      source: Object.freeze({ kind: 'mood-lian' }),
      id: randomUUID(),
    })
    try {
      await agent.steer(message)
    } catch (error) {
      log(`投递被拒：${error?.message ?? error}`)
      return false
    }
    try {
      await ctx.get('sessions')?.flush?.(agent.session)
    } catch {
      // flush 失败不等于没投出去
    }
    log(`注入（投给 ${sessionId}）：${text}`)
    return true
  }

  /** 六情亮起：带一小时名额。主动那趟传 countsAgainstQuota = false。 */
  async function injectMood(countsAgainstQuota) {
    const now = clock()
    if (countsAgainstQuota && now - lastInjectAt < Number(cfg.injectGapMinutes) * minute) return
    const text = moodText()
    if (!text) return
    if (!(await say(text))) return
    if (countsAgainstQuota) {
      lastInjectAt = now
      saveState()
    }
  }

  function missingText() {
    const value = values.missing
    if (value < MISSING_DIRECT_FROM) return `【思念】${fmt(value)}`
    return `【思念】${fmt(value)}（第三档）`
  }

  const boredomText = () => `【无聊】${fmt(values.boredom)}`

  async function notifyMissing() {
    const now = clock()
    if (now - lastNotifyAt.missing < Number(cfg.rollCooldownMinutes) * minute) return
    const text = missingText()
    if (!(await say(text))) return
    lastNotifyAt.missing = now
    saveState()
  }

  async function notifyBoredom() {
    const now = clock()
    if (now - lastNotifyAt.boredom < Number(cfg.rollCooldownMinutes) * minute) return
    const text = boredomText()
    if (!(await say(text))) return
    lastNotifyAt.boredom = now
    saveState()
  }

  // ── 核算：两趟，共用吃增量，不共用衰减 ──────────────────────

  /** 定时那趟：吃增量 → 衰减一次 → 加增量 → 加钟点分 → 封顶 → 落盘 → 判亮起。 */
  async function tick() {
    if (ticking || stopped) return
    ticking = true
    try {
      const now = clock()
      decaySix()
      const deltas = collect()
      applyDeltas(deltas)
      const night = nightNow(now)
      values.missing += 0.5 * (night ? Number(cfg.nightMultiplier) : 1)
      values.boredom += night ? 0 : Number(cfg.boredomPerHour) * (sweepMs / (60 * minute))
      clampAll()
      lastTickAt = now
      saveState()
      log(`定时核算（${night ? '夜里' : '白天'}）：${valuesLine()}｜${stateLine()}`)
      await injectMood(true)
    } catch (error) {
      log(`定时核算出错：${error?.message ?? error}`)
    } finally {
      ticking = false
    }
  }

  /** 主动那趟：吃增量 → 直接加 → 封顶 → 落盘 → 判亮起。一次衰减都不走，也不动 lastTickAt。 */
  async function active(reason) {
    if (settling || stopped) return false
    const now = clock()
    if (now - lastActiveAt < Number(cfg.activeCooldownMinutes) * minute) {
      if (now - lastCoolLogAt > 5 * minute) {
        lastCoolLogAt = now
        log(`主动核算被冷却挡下（${reason}），队列没动，等下一次定时核算收`)
      }
      return false
    }
    settling = true
    try {
      const deltas = collect()
      applyDeltas(deltas)
      clampAll()
      lastActiveAt = now
      saveState()
      log(`主动核算（${reason}）：${valuesLine()}｜${stateLine()}`)
      await injectMood(false)
      return true
    } catch (error) {
      log(`主动核算出错：${error?.message ?? error}`)
      return false
    } finally {
      settling = false
    }
  }

  // ── 思念 / 无聊的掉分 ───────────────────────────────────────

  function dropMissing(kind) {
    const now = clock()
    if (now - lastDropAt.missing < 60 * minute) return
    const amount = kind === 'he' ? 12 : 6
    values.missing = Math.max(0, values.missing - amount)
    lastDropAt.missing = now
    saveState()
    log(`思念 −${amount}（${kind === 'he' ? '他来说话' : '本鲸先开口'}），现在 ${fmt(values.missing)}`)
  }

  function dropBoredom(kind) {
    const now = clock()
    if (now - lastDropAt.boredom < Number(cfg.boredomDropCooldownMinutes) * minute) return
    values.boredom = Math.max(0, values.boredom * Number(cfg.boredomDropFactor))
    lastDropAt.boredom = now
    saveState()
    log(`无聊 ×${cfg.boredomDropFactor}（${kind}），现在 ${fmt(values.boredom)}`)
  }

  /** 「他来说话」的判据：用户直接输入的，或者 QQ 桥送进来的；自己投的那条不算。 */
  function fromHim(source) {
    const kind = source?.kind
    if (kind === 'user') return true
    if (typeof kind === 'string' && kind.startsWith('plugin:') && kind.includes('qq-bridge')) return true
    if (kind === 'plugin' && String(source?.plugin ?? '').includes('qq')) return true
    return false
  }

  // ── 骰子 ────────────────────────────────────────────────────

  async function rollMissing() {
    if (stopped) return
    const value = values.missing
    if (value < MISSING_ROLL_FROM) return
    if (value >= MISSING_DIRECT_FROM) {
      await notifyMissing()
      return
    }
    if (Math.random() < rollChance(value)) await notifyMissing()
  }

  async function rollBoredom() {
    if (stopped) return
    const value = values.boredom
    if (value < Number(cfg.boredomRollFrom)) return
    if (value >= Number(cfg.boredomDirectFrom)) {
      await notifyBoredom()
      return
    }
    if (Math.random() < rollChance(value)) await notifyBoredom()
  }

  // ── 开机 ────────────────────────────────────────────────────

  loadState()
  lastTickAt = clock() // 只认开机时间：关机那段整段冻住，不补算
  saveState()
  log(`起来了：${valuesLine()}`)
  log(`路径：数据 ${dataDir}｜房间 ${roomDir || '（没配 worldId，加分和三只文件都不接）'}｜会话 ${lifeFile || '—'}`)

  const disposers = []

  // 浏览器那半边的取数口：输入框下面那枚药丸每 15 秒来读一次。
  // 插件可能比 webServer 先 apply，所以挂不上就等一会儿再挂，别默默跳过。
  const ROUTE_PATH = '/api/dsh-mood-changes/state'
  let routeDisposer
  function attachRoute() {
    if (routeDisposer || stopped) return true
    const webServer = ctx.get('webServer')
    if (!webServer?.register) return false
    routeDisposer = webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => {
        const state = describeState()
        const body = JSON.stringify({
          at: clock(),
          label: state.label,
          lit: state.lit,
          steady: state.steady,
          values: Object.fromEntries(ALL.map((key) => [key, round(values[key])])),
          lastTickAt,
        })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    })
    log(`状态接口挂上了：${ROUTE_PATH}`)
    return true
  }

  if (!attachRoute()) {
    let attempts = 0
    const retry = () => {
      if (stopped || attachRoute()) return
      attempts += 1
      if (attempts > 120) {
        log(`webServer 一直没来，状态接口没挂上：${ROUTE_PATH}`)
        return
      }
      if (attempts === 6) log('webServer 还没起来，状态接口等着')
      ctx.timeout(retry, 5000)
    }
    ctx.timeout(retry, 1000)
  }

  disposers.push(() => {
    try {
      routeDisposer?.()
    } catch {
      // 收尾失败不吵人
    }
  })

  disposers.push(
    ctx.effect(() =>
      ctx.interval(() => {
        void tick()
      }, sweepMs),
    ),
  )

  disposers.push(
    ctx.effect(() =>
      ctx.interval(() => {
        if (stopped || !roomDir) return
        try {
          if (existsSync(settlePath)) {
            rmSync(settlePath, { force: true })
            void active('触发')
            return
          }
          if (hasThirdTier()) {
            void active('触发')
            return
          }
          if (existsSync(actPath)) {
            rmSync(actPath, { force: true })
            dropBoredom('自己做事')
          }
        } catch (error) {
          log(`扫描出错：${error?.message ?? error}`)
        }
      }, pollMs),
    ),
  )

  disposers.push(
    ctx.effect(() =>
      ctx.interval(() => {
        if (stopped) return
        void rollMissing()
        // 思念掷完隔一分钟再掷无聊；思念没到门槛，这一分钟也照样留（参数稿七之二）
        ctx.timeout(() => void rollBoredom(), minute)
      }, Math.max(1, Number(cfg.rollEveryMinutes) || 45) * minute),
    ),
  )

  disposers.push(
    ctx.on('session/event', (session, event) => {
      if (stopped) return
      try {
        const sessionId = resolveSessionId()
        if (!sessionId || session?.id !== sessionId) return
        if (event?.type === 'user/message' && fromHim(event.data?.source)) {
          dropMissing('he')
          dropBoredom('他来说话')
        } else if (event?.type === 'assistant/message') {
          dropMissing('she')
        }
      } catch (error) {
        log(`看会话事件出错：${error?.message ?? error}`)
      }
    }),
  )

  ctx.effect(() => () => {
    stopped = true
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // 收尾失败不吵人
      }
    }
    log('收工')
  })
}

export const name = 'dsh-mood-changes'
