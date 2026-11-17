/**
 * 插件宿主半边：注册 LLM 提供商 + 用量路由 + 后台轮询。
 *
 * 对外只有三样东西：
 *   - 提供商 <provider.id>（默认 opencode-go）：模型选择框里的一项，内部自动选号；
 *   - GET  /plugins/dsh-opencode-go-pool/state?session=<sid>：给 UI 的快照；
 *   - POST /plugins/dsh-opencode-go-pool/refresh：强制刷一次上游用量。
 *
 * 全部配置/状态都落在 ~/.dsh/opencode-go-pool/（config.json / state.json），
 * 插件包自身在 ~/.dsh/plugin-src/dsh-opencode-go-pool/，不改 DSH 安装目录。
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CONFIG_PATH, ConfigError, DEFAULT_MODEL, POOL_DIR, loadConfig, watchConfig } from './config.mjs'
import { OpenCodeGoAdapter } from './adapter.mjs'
import { CLIENT_VERSION } from './identity.mjs'
import { formatScore } from './pool.mjs'
import { StateStore } from './state.mjs'
import { UsageRegistry } from './usage.mjs'

/** cordis 插件名。 */
export const name = 'opencode-go-pool'
/** 依赖的宿主服务：LLM 注册表 + Web 路由表。 */
export const inject = ['llm', 'webServer']

/** 快照路由。 */
const STATE_PATH = '/plugins/dsh-opencode-go-pool/state'
/** 强刷路由。 */
const REFRESH_PATH = '/plugins/dsh-opencode-go-pool/refresh'
/** 显隐诊断路由（客户端上报它看到的模型选择，用于排查「别的提供商也显示」）。 */
const DIAG_PATH = '/plugins/dsh-opencode-go-pool/diag'
/** 账号增删改路由（面板上的「＋ / 停用 / 删除」走这里）。 */
const ACCOUNTS_PATH = '/plugins/dsh-opencode-go-pool/accounts'
/** 诊断落盘文件（保留最近 30 条）。 */
const DIAG_FILE = join(POOL_DIR, 'diag.json')
/** 曲线最多给 UI 多少个点。 */
const MAX_SAMPLE_POINTS = 60

/** 配置坏掉时也要能启动：给一份空号的壳，UI 会显示错误原因。 */
function fallbackConfig() {
  return {
    provider: { id: 'opencode-go', name: 'OpenCode Go' },
    baseUrl: 'https://opencode.ai/zen/go/v1',
    reserveDays: 3.5,
    usageRefreshMs: 60000,
    usageTimeoutMs: 8000,
    requestTimeoutMs: 180000,
    maxFailoverAttempts: 3,
    models: [DEFAULT_MODEL],
    accounts: [],
  }
}

/** 采样抽稀：等间隔取，始终保留最后一个点。 */
function downsample(samples, limit) {
  if (!Array.isArray(samples) || samples.length <= limit) return samples
  const step = Math.ceil(samples.length / limit)
  const out = []
  for (let index = 0; index < samples.length; index += step) out.push(samples[index])
  const last = samples[samples.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/** 打分序列化成 UI 可读的样子（JSON 放不下 Infinity）。 */
function scoreWire(score) {
  if (score === Number.POSITIVE_INFINITY) return { scoreValue: 1e9, scoreText: '∞' }
  if (Number.isNaN(score)) return { scoreValue: -1, scoreText: '—' }
  return { scoreValue: score, scoreText: formatScore(score) }
}

/**
 * prompt cache 命中率：cacheRead / (input + cacheRead)。
 * input 已经是网关回报的「未命中」部分（sse.mapUsage 把命中量减掉了），两者不重叠。
 * @param {{cacheRead?: number, input?: number, cacheHits?: number}} local - 本地用量计。
 * @returns {{readTokens: number, hitRequests: number, hitRate: number|undefined}} UI 片段。
 */
function cacheStatsOf(local) {
  const cacheRead = typeof local?.cacheRead === 'number' ? local.cacheRead : 0
  const input = typeof local?.input === 'number' ? local.input : 0
  const total = cacheRead + input
  return {
    readTokens: cacheRead,
    hitRequests: typeof local?.cacheHits === 'number' ? local.cacheHits : 0,
    hitRate: total > 0 ? cacheRead / total : undefined,
  }
}

/**
 * 读 config.json 原文（不存在或坏掉时给一份最小壳，保证面板还能操作）。
 * @returns {Promise<object>} 原始配置对象。
 */
async function readRawConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return { provider: { id: 'opencode-go', name: 'OpenCode Go' }, accounts: [] }
  }
}

/** 原子写 config.json（tmp + rename，避免写到一半被 watcher 读到）。 */
async function writeRawConfig(next) {
  const tmp = `${CONFIG_PATH}.tmp`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tmp, CONFIG_PATH)
}

/**
 * 下一个可用序号：id（go-N）和凭据引用（OPENCODE_GO_N_API_KEY）都要避让。
 * @param {Array<object>} accounts - 现有账号条目（原始 JSON）。
 * @returns {number} 可用序号。
 */
function nextAccountIndex(accounts) {
  const taken = new Set()
  for (const account of accounts) {
    taken.add(String(account?.id ?? ''))
    taken.add(String(account?.apiKeyEnv ?? ''))
  }
  for (let candidate = 1; candidate < 1000; candidate += 1) {
    if (!taken.has(`go-${candidate}`) && !taken.has(`OPENCODE_GO_${candidate}_API_KEY`)) return candidate
  }
  return Math.floor(Date.now() % 100000)
}

/**
 * 插件主体。
 * @param {object} ctx - cordis 上下文。
 */
export function apply(ctx) {
  const logger = ctx.logger
  let configError
  let config
  try {
    config = loadConfig()
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error)
    config = fallbackConfig()
    logger?.warn?.(`[opencode-go-pool] 配置加载失败，先用空壳启动：${configError}`)
  }

  const state = new StateStore()
  const usage = new UsageRegistry({ ctx, getConfig: () => config, state, logger })
  const adapter = new OpenCodeGoAdapter({ ctx, getConfig: () => config, state, usage, logger })

  /** 组装给 UI 的快照。 */
  function buildSnapshot(sessionId) {
    const now = Date.now()
    const pinned = state.sessionAccount(sessionId)
    // 面板要能展示并重新启用停用的号，所以列全部账号（停用的不带分数、不参与选号）。
    const accounts = (config.allAccounts ?? config.accounts).map((account) => {
      const data = usage.usage(account.id)
      const entry = usage.entry(account.id)
      const percent = data?.monthly?.percent
      const daysLeft = typeof data?.monthly?.resetsAt === 'number' ? (data.monthly.resetsAt - now) / 86400000 : undefined
      const usable = typeof percent === 'number' ? (100 - Math.min(Math.max(percent, 0), 100)) / 100 : undefined
      const denominator = daysLeft === undefined ? undefined : Math.max(daysLeft - config.reserveDays, 0)
      const local = state.local(account.id)
      const score = usable === undefined
        ? Number.NaN
        : usable <= 0
          ? 0
          : denominator === 0 ? Number.POSITIVE_INFINITY : usable / denominator
      return {
        id: account.id,
        label: account.label,
        enabled: account.enabled !== false,
        apiKeyEnv: account.apiKeyEnv,
        pinned: pinned === account.id,
        monthly: data?.monthly,
        weekly: data?.weekly,
        rolling: data?.rolling,
        daysLeft,
        ...scoreWire(score),
        exhausted: typeof percent === 'number' && percent >= 100,
        cooldownUntil: state.cooldown(account.id),
        fetchedAt: entry?.fetchedAt,
        error: entry?.error,
        local,
        cache: cacheStatsOf(local),
        samples: downsample(state.samples(account.id), MAX_SAMPLE_POINTS),
      }
    })
    return {
      ok: configError === undefined,
      error: configError,
      plugin: { version: CLIENT_VERSION },
      provider: config.provider,
      models: config.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        defaultEffort: model.defaultEffort,
        efforts: Object.keys(model.efforts),
      })),
      reserveDays: config.reserveDays,
      now,
      sessionAccount: pinned,
      accountCount: config.accounts.length,
      accounts,
    }
  }

  /** 统一 JSON 响应。 */
  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter([config.provider.id], adapter)
    const stopWatch = watchConfig((next, error) => {
      if (next === undefined) {
        configError = error instanceof Error ? error.message : String(error)
        logger?.warn?.(`[opencode-go-pool] 配置热重载失败，继续用旧配置：${configError}`)
        return
      }
      configError = undefined
      config = next
      logger?.info?.(`[opencode-go-pool] 配置已重载：${next.accounts.length} 个账号 / ${next.models.length} 个模型`)
      // 关键：通知 LLM 注册表重新发布路由（会 emit "llm/adapters-updated"）。
      // GUI 的模型目录只在收到这个事件时重拉；不 replace 的话，模型菜单会一直停留在
      // 启动时的那份列表（哪怕 config.json 里已经有 30 个模型）。
      try {
        registration?.replace?.([config.provider.id])
      } catch (replaceError) {
        logger?.warn?.(`[opencode-go-pool] 重新发布 provider 路由失败（模型菜单可能要重启才更新）：${replaceError instanceof Error ? replaceError.message : String(replaceError)}`)
      }
    })

    const disposeState = ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          sendJson(res, 200, buildSnapshot(url.searchParams.get('session') ?? undefined))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    const disposeRefresh = ctx.webServer.register({
      kind: 'exact',
      path: REFRESH_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          await usage.refreshAll({ force: true })
          sendJson(res, 200, buildSnapshot(url.searchParams.get('session') ?? undefined))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    const disposeDiag = ctx.webServer.register({
      kind: 'exact',
      path: DIAG_PATH,
      handler: async (req, res) => {
        try {
          let body = ''
          for await (const chunk of req) body += chunk
          const raw = JSON.parse(body || '{}')
          const record = { at: new Date().toISOString(), ...raw }
          let previous = []
          try {
            previous = JSON.parse(await readFile(DIAG_FILE, 'utf8'))
            if (!Array.isArray(previous)) previous = []
          } catch { previous = [] }
          previous.push(record)
          await writeFile(DIAG_FILE, `${JSON.stringify(previous.slice(-30), null, 2)}\n`, 'utf8')
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    const disposeAccounts = ctx.webServer.register({
      kind: 'exact',
      path: ACCOUNTS_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'accounts 只接受 POST' })
            return
          }
          let body = ''
          for await (const chunk of req) body += chunk
          const input = JSON.parse(body || '{}')
          const action = typeof input.action === 'string' ? input.action : ''
          const raw = await readRawConfig()
          const accounts = Array.isArray(raw.accounts) ? raw.accounts.slice() : []

          if (action === 'add') {
            const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
            if (apiKey === '') throw new Error('API key 不能为空')
            const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
            if (credentials === undefined || typeof credentials.set !== 'function') {
              throw new Error('凭证服务不可用：请把 key 写进 ~/.dsh/.credentials.yaml 的 refs，再在 config.json 里加账号')
            }
            const index = nextAccountIndex(accounts)
            const ref = `OPENCODE_GO_${index}_API_KEY`
            const label = typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim() : `Go ${index}`
            // 先落凭证：写配置失败时最多留一个没被引用的 key，不会出现「账号指向空引用」。
            await credentials.set(ref, apiKey)
            accounts.push({ id: `go-${index}`, label, apiKeyEnv: ref, enabled: true })
          } else if (action === 'remove') {
            const id = String(input.id ?? '')
            const index = accounts.findIndex((account) => String(account?.id ?? '') === id)
            if (index < 0) throw new Error(`没有账号 ${id}`)
            const remaining = accounts.filter((_, position) => position !== index)
            if (remaining.filter((account) => account?.enabled !== false).length === 0) {
              throw new Error('至少要保留一个启用中的账号')
            }
            accounts.splice(index, 1)
          } else if (action === 'toggle') {
            const id = String(input.id ?? '')
            const target = accounts.find((account) => String(account?.id ?? '') === id)
            if (target === undefined) throw new Error(`没有账号 ${id}`)
            target.enabled = input.enabled === undefined ? target.enabled === false : input.enabled !== false
          } else {
            throw new Error(`未知操作：${action || '(空)'}`)
          }

          raw.accounts = accounts
          const previous = await readFile(CONFIG_PATH, 'utf8').catch(() => undefined)
          await writeRawConfig(raw)
          try {
            config = loadConfig()
            configError = undefined
          } catch (error) {
            // 写坏了就回滚，别把可用配置留在坏状态里。
            if (previous !== undefined) await writeFile(CONFIG_PATH, previous, 'utf8').catch(() => {})
            throw error
          }
          logger?.info?.(`[opencode-go-pool] 账号变更（${action}）→ 现在 ${config.accounts.length} 个启用账号`)
          sendJson(res, 200, buildSnapshot(typeof input.session === 'string' ? input.session : undefined))
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    usage.start()
    logger?.info?.(`[opencode-go-pool] provider "${config.provider.id}" 已注册，${config.accounts.length} 个账号，预留 ${config.reserveDays} 天`)

    return () => {
      usage.stop()
      stopWatch()
      try { registration.dispose() } catch { /* 已释放 */ }
      disposeState()
      disposeRefresh()
      disposeDiag()
      disposeAccounts()
      state.dispose()
    }
  }, 'opencode-go-pool: provider + usage routes')
}

export { ConfigError }
