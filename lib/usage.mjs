/**
 * 用量层：直连 OpenCode Go 的用量接口，不碰 cookie、不解析 HTML。
 *
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <api key>
 *   → { usage: { rolling: {status,percent,resetsAt}, weekly: {...}, monthly: {...} } }
 *
 * 实测（2026-11-03）：三个 key 都返回 200，monthly.percent 就是套餐使用率，
 * monthly.resetsAt 就是「套餐截至时间」。轮询 60s 一次，把 percent 采成曲线。
 */
import { resolveAccountKey } from './api-keys.mjs'
import { usageRequestHeaders } from './identity.mjs'

/** 用量接口路径（相对 baseUrl）。 */
const USAGE_PATH = '/usage'

/** 一个窗口的归一化视图。 */
function windowOf(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const percent = typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? raw.percent : 0
  const resetsAt = typeof raw.resetsAt === 'string' ? Date.parse(raw.resetsAt) : Number.NaN
  return {
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    percent,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
  }
}

/**
 * 把线上返回归一化成 {rolling,weekly,monthly}。
 * @param {unknown} payload - 响应体。
 * @returns {object|undefined} 归一化结果；形状不对返回 undefined。
 */
export function normalizeUsage(payload) {
  const usage = payload?.usage
  if (usage === null || typeof usage !== 'object') return undefined
  const rolling = windowOf(usage.rolling)
  const weekly = windowOf(usage.weekly)
  const monthly = windowOf(usage.monthly)
  if (monthly === undefined) return undefined
  return { rolling, weekly, monthly }
}

/** 网络/协议错误，带 code 方便上层决定是否换号。 */
export class UsageError extends Error {
  constructor(message, code, status) {
    super(message)
    this.name = 'UsageError'
    this.code = code
    this.status = status
  }
}

/**
 * 拉一次某个账号的用量。
 * @param {object} ctx - 宿主上下文。
 * @param {object} config - 规范配置。
 * @param {object} account - 账号。
 * @param {AbortSignal} [outerSignal] - 外部取消信号。
 * @returns {Promise<object>} 归一化用量。
 */
export async function fetchUsage(ctx, config, account, outerSignal) {
  const { key } = await resolveAccountKey(ctx, account)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('usage timeout')), config.usageTimeoutMs)
  const onAbort = () => controller.abort(outerSignal?.reason)
  outerSignal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(`${config.baseUrl}${USAGE_PATH}`, {
      method: 'GET',
      // 同一份 UA（lib/identity.mjs）：用量查询与推理请求对外是同一个客户端。
      headers: usageRequestHeaders(key),
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      throw new UsageError(`用量接口鉴权失败（${response.status}）`, 'auth', response.status)
    }
    if (!response.ok) {
      throw new UsageError(`用量接口返回 ${response.status}`, response.status === 429 ? 'rate' : 'http', response.status)
    }
    const normalized = normalizeUsage(await response.json())
    if (normalized === undefined) throw new UsageError('用量接口返回了无法识别的形状', 'shape', response.status)
    return normalized
  } catch (error) {
    if (error instanceof UsageError) throw error
    if (outerSignal?.aborted) throw new UsageError('用量查询被取消', 'aborted')
    throw new UsageError(`用量查询失败：${error instanceof Error ? error.message : String(error)}`, 'network')
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 用量缓存表：每账号一份最近一次结果 + 采样落盘 + 后台轮询。
 */
export class UsageRegistry {
  /**
   * @param {object} options - { ctx, getConfig, state, logger }。
   */
  constructor({ ctx, getConfig, state, logger }) {
    this.ctx = ctx
    this.getConfig = getConfig
    this.state = state
    this.logger = logger
    /** @type {Map<string, {usage?: object, fetchedAt: number, error?: string, errorCode?: string}>} */
    this.entries = new Map()
    /** @type {Map<string, Promise<object>>} */
    this.inflight = new Map()
    this.timer = undefined
    this.stopped = false
  }

  /** 缓存条目（可能为空）。 */
  entry(accountId) {
    return this.entries.get(accountId)
  }

  /** 最近一次成功用量（不管新鲜度）。 */
  usage(accountId) {
    return this.entries.get(accountId)?.usage
  }

  /**
   * 刷新一个账号；并发调用共享同一次请求。
   * @param {object} account - 账号。
   * @param {{ force?: boolean }} [options] - force 忽略新鲜度。
   * @returns {Promise<object|undefined>} 用量或 undefined（失败）。
   */
  async refresh(account, { force = false } = {}) {
    const config = this.getConfig()
    const cached = this.entries.get(account.id)
    if (!force && cached !== undefined && cached.usage !== undefined && Date.now() - cached.fetchedAt < config.usageRefreshMs) {
      return cached.usage
    }
    const running = this.inflight.get(account.id)
    if (running !== undefined) return running
    const task = (async () => {
      try {
        const usage = await fetchUsage(this.ctx, config, account)
        this.entries.set(account.id, { usage, fetchedAt: Date.now() })
        this.state.addSample(account.id, {
          t: Date.now(),
          m: usage.monthly.percent,
          r: usage.rolling?.percent ?? 0,
          w: usage.weekly?.percent ?? 0,
        })
        return usage
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger?.warn?.(`[opencode-go-pool] 用量查询失败 ${account.label}: ${message}`)
        this.entries.set(account.id, {
          ...(this.entries.get(account.id) ?? { fetchedAt: 0 }),
          error: message,
          errorCode: error?.code ?? 'unknown',
          failedAt: Date.now(),
        })
        return this.entries.get(account.id)?.usage
      } finally {
        this.inflight.delete(account.id)
      }
    })()
    this.inflight.set(account.id, task)
    return task
  }

  /** 并发刷新全部账号。 */
  async refreshAll(options = {}) {
    const accounts = this.getConfig().accounts
    await Promise.allSettled(accounts.map((account) => this.refresh(account, options)))
  }

  /** 启动后台轮询（配置里的 usageRefreshMs）。 */
  start() {
    const tick = () => {
      if (this.stopped) return
      void this.refreshAll().finally(() => {
        if (this.stopped) return
        const interval = Math.max(this.getConfig().usageRefreshMs, 10000)
        this.timer = setTimeout(tick, interval)
        if (typeof this.timer.unref === 'function') this.timer.unref()
      })
    }
    this.timer = setTimeout(tick, 1500)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 停止轮询。 */
  stop() {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
