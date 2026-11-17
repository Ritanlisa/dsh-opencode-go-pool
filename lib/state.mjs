/**
 * 状态层：会话钉号、账号冷却、用量采样曲线、本地用量计。
 *
 * 落盘 ~/.dsh/opencode-go-pool/state.json（临时文件 + rename 原子替换，
 * 800ms 防抖）。进程重启后会话仍然记得自己开头用的哪个号——这正是
 * 「每个会话默认沿用开始时的号」跨越重启的实现。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { STATE_PATH } from './config.mjs'

/** 采样保留窗口：7 天足够画「最近一周」的曲线。 */
const SAMPLE_RETENTION_MS = 7 * 24 * 3600 * 1000
/** 每个账号最多保留的采样点数（超了隔点抽稀，保两头）。 */
const SAMPLE_MAX = 1440
/** 会话钉号保留窗口：一个会话活过 30 天也该重新评估了。 */
const SESSION_RETENTION_MS = 30 * 24 * 3600 * 1000
/** 钉号表上限。 */
const SESSION_MAX = 2000

/** 空状态骨架。 */
function emptyState() {
  return { version: 1, sessions: {}, cooldown: {}, samples: {}, local: {} }
}

/** 深拷贝一个可 JSON 序列化的对象（只用于内部小状态）。 */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export class StateStore {
  /**
   * @param {string} [path] - 状态文件路径（测试可覆盖）。
   */
  constructor(path = STATE_PATH) {
    this.path = path
    this.state = emptyState()
    this.timer = undefined
    this.load()
  }

  /** 读盘；坏文件不阻塞启动（重命名留档后从空状态开始）。 */
  load() {
    try {
      if (!existsSync(this.path)) return
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') {
        this.state = { ...emptyState(), ...parsed }
      }
    } catch {
      try { renameSync(this.path, `${this.path}.corrupt-${Date.now()}`) } catch { /* 留档失败就算了 */ }
      this.state = emptyState()
    }
  }

  /** 防抖落盘。 */
  saveSoon() {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.save()
    }, 800)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 立即落盘（原子替换）。 */
  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      renameSync(tmp, this.path)
    } catch {
      // 状态落盘失败不影响推理主链路。
    }
  }

  /** 关停时清定时器并落盘。 */
  dispose() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.save()
  }

  /**
   * 兜底会话 id：DSH 没给 sessionId 的请求也要带会话头（网关缺了直接 400）。
   * 落盘保存，保证进程重启后仍是同一个 id——否则重启等于换了个缓存桶，prompt cache 全冷。
   * @returns {string} 稳定的兜底 id。
   */
  fallbackSession() {
    const current = this.state.fallbackSession
    if (typeof current === 'string' && current !== '') return current
    const next = `dsh-opencode-go-pool-${randomUUID()}`
    this.state.fallbackSession = next
    this.saveSoon()
    return next
  }

  /** 取某会话钉住的账号 id。 */
  sessionAccount(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const row = this.state.sessions[sessionId]
    if (row === undefined) return undefined
    if (Date.now() - row.at > SESSION_RETENTION_MS) {
      delete this.state.sessions[sessionId]
      return undefined
    }
    return row.accountId
  }

  /** 钉住某会话的账号（会话内不再漂移）。 */
  pinSession(sessionId, accountId, reason = 'start') {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const sessions = this.state.sessions
    const row = sessions[sessionId]
    sessions[sessionId] = { accountId, at: Date.now(), reason, switches: (row?.switches ?? 0) + (row?.accountId === accountId ? 0 : row === undefined ? 0 : 1) }
    const keys = Object.keys(sessions)
    if (keys.length > SESSION_MAX) {
      keys.sort((a, b) => (sessions[a].at ?? 0) - (sessions[b].at ?? 0))
      for (const key of keys.slice(0, keys.length - SESSION_MAX)) delete sessions[key]
    }
    this.saveSoon()
  }

  /** 账号冷却截止时间（毫秒时间戳），过期为 undefined。 */
  cooldown(accountId) {
    const until = this.state.cooldown[accountId]
    return typeof until === 'number' && until > Date.now() ? until : undefined
  }

  /** 把账号打进冷却（额度耗尽/鉴权失败时）。 */
  setCooldown(accountId, until) {
    this.state.cooldown[accountId] = Math.max(until, Date.now())
    this.saveSoon()
  }

  /** 清除冷却（例如手动刷新到额度回来了）。 */
  clearCooldown(accountId) {
    if (this.state.cooldown[accountId] !== undefined) {
      delete this.state.cooldown[accountId]
      this.saveSoon()
    }
  }

  /** 追加一个用量采样点 {t, m, r, w}（percent）。 */
  addSample(accountId, sample) {
    const list = this.state.samples[accountId] ?? (this.state.samples[accountId] = [])
    const last = list[list.length - 1]
    // 同分钟同值不重复记，避免轮询把曲线撑爆。
    if (last !== undefined && sample.t - last.t < 60000 && last.m === sample.m && last.r === sample.r && last.w === sample.w) return
    list.push(sample)
    const cutoff = Date.now() - SAMPLE_RETENTION_MS
    while (list.length > 0 && list[0].t < cutoff) list.shift()
    if (list.length > SAMPLE_MAX) {
      const thinned = []
      for (let index = 0; index < list.length; index += 2) thinned.push(list[index])
      this.state.samples[accountId] = thinned
    }
    this.saveSoon()
  }

  /** 取某账号的采样序列（浅拷贝）。 */
  samples(accountId) {
    return this.state.samples[accountId] ?? []
  }

  /**
   * 本地用量计：本插件自己请求累计的 allowance 美元数、token 与请求数。
   * cacheRead 是网关回报的 prompt cache 命中 token（mapUsage 已经把 inputTokens 里的命中量减掉），
   * 所以命中率 = cacheRead / (input + cacheRead)。
   * @param {string} accountId - 账号 id。
   * @param {{usd?: number, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number}} delta - 本次增量。
   */
  addLocal(accountId, { usd = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0 } = {}) {
    const row = this.state.local[accountId]
      ?? (this.state.local[accountId] = { usd: 0, input: 0, output: 0, cacheRead: 0, cacheHits: 0, requests: 0, since: Date.now() })
    row.usd += usd
    row.input += inputTokens
    row.output += outputTokens
    row.cacheRead = (row.cacheRead ?? 0) + cacheReadTokens
    if (cacheReadTokens > 0) row.cacheHits = (row.cacheHits ?? 0) + 1
    row.requests += 1
    this.saveSoon()
  }

  /** 本地用量计快照（老状态文件没有 cacheRead/cacheHits，按 0 补齐）。 */
  local(accountId) {
    const row = this.state.local[accountId]
    if (row === undefined) return { usd: 0, input: 0, output: 0, cacheRead: 0, cacheHits: 0, requests: 0, since: Date.now() }
    return { cacheRead: 0, cacheHits: 0, ...row }
  }

  /** 导出给 UI 的可序列化片段。 */
  snapshot(sessionId) {
    return {
      sessionAccount: this.sessionAccount(sessionId),
      sessions: Object.keys(this.state.sessions).length,
      cooldown: clone(this.state.cooldown),
    }
  }
}
