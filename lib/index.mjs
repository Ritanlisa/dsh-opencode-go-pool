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
import { randomBytes } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { CONFIG_PATH, ConfigError, DEFAULT_MODEL, POOL_DIR, loadConfig, watchConfig } from './config.mjs'
import { OpenCodeGoAdapter } from './adapter.mjs'
import { resolveAccountKey } from './api-keys.mjs'
import { CLIENT_VERSION, USER_AGENT } from './identity.mjs'
import { startPoolProxy, syncTranslateEndpoint } from './local-proxy.mjs'
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
/** 手动切换账号（面板「切到该号」）。 */
const SWITCH_PATH = '/plugins/dsh-opencode-go-pool/switch'
/** 解除账号冷却（面板「解除冷却」）。 */
const CLEAR_COOLDOWN_PATH = '/plugins/dsh-opencode-go-pool/clear-cooldown'
/** 从官方 /models 拉取最新模型目录并并入 config.json。 */
const MODELS_REFRESH_PATH = '/plugins/dsh-opencode-go-pool/models-refresh'
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
 * 官方 `/models` 的一个条目 → config.json 的模型条目。
 * 元数据口径与手工生成的 30 个模型一致（context/maxTokens/input/efforts）。
 * @param {object} item - 官方条目。
 * @returns {object} 配置条目。
 */
function toModelEntry(item) {
  const inputs = Array.isArray(item?.modalities?.input) ? item.modalities.input.map(String) : []
  const context = Number(item?.limit?.context)
  const output = Number(item?.limit?.output)
  return {
    id: String(item?.id ?? ''),
    name: typeof item?.name === 'string' && item.name !== '' ? item.name : String(item?.id ?? ''),
    contextWindow: Number.isFinite(context) && context > 0 ? context : 128000,
    maxTokens: Number.isFinite(output) && output > 0 ? output : 8192,
    input: inputs.some((value) => value.startsWith('image')) ? ['text', 'image'] : ['text'],
    defaultEffort: 'high',
    efforts: { off: 'none', low: 'low', high: 'high', max: 'max' },
  }
}

/**
 * 合并模型目录：已有条目保序更新，新模型追加到末尾，官方已下架的保留（不擅自删）。
 * @param {Array<object>} existing - 现有配置条目。
 * @param {Array<object>} incoming - 官方条目（已转成配置形状）。
 * @returns {{models: Array<object>, summary: {total: number, added: string[], updated: string[], stale: string[]}}} 合并结果。
 */
function mergeModels(existing, incoming) {
  const byId = new Map(incoming.filter((model) => model.id !== '').map((model) => [model.id, model]))
  const models = []
  const seen = new Set()
  const added = []
  const updated = []
  for (const old of existing) {
    const id = String(old?.id ?? '')
    const next = byId.get(id)
    if (next === undefined) {
      models.push(old)
      seen.add(id)
      continue
    }
    models.push(next)
    seen.add(id)
    if (JSON.stringify(old) !== JSON.stringify(next)) updated.push(id)
  }
  for (const model of incoming) {
    if (model.id === '' || seen.has(model.id)) continue
    models.push(model)
    seen.add(model.id)
    added.push(model.id)
  }
  const stale = models.filter((model) => !byId.has(String(model?.id ?? ''))).map((model) => String(model.id))
  return { models, summary: { total: models.length, added, updated, stale } }
}

/** 本地翻译代理的 Bearer token 落盘位置（0600）。 */
const PROXY_TOKEN_PATH = join(POOL_DIR, 'proxy-token')
/** DSH home（论文伴读按 DSH_HOME 或 ~/.dsh 取配置目录，这里必须一致）。 */
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
/** 论文伴读的翻译端点存储（它自己的配置目录，避免跟着文献库同步）。 */
const TRANSLATE_STORE_PATH = join(DSH_HOME, '.dsh-paper-reader', 'translate.json')

/**
 * 读或生成本地代理 token；文件不存在就创建一个 48 位十六进制串。
 * @returns {Promise<string>} token。
 */
async function ensureProxyToken() {
  try {
    const existing = (await readFile(PROXY_TOKEN_PATH, 'utf8')).trim()
    if (/^[0-9a-f]{48}$/.test(existing)) return existing
  } catch { /* 首次运行 */ }
  const token = randomBytes(24).toString('hex')
  await mkdir(POOL_DIR, { recursive: true })
  await writeFile(PROXY_TOKEN_PATH, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(PROXY_TOKEN_PATH, 0o600).catch(() => {})
  return token
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

    /** 读一个 POST 请求的 JSON body。 */
    const readJsonBody = async (req) => {
      let body = ''
      for await (const chunk of req) body += chunk
      return JSON.parse(body || '{}')
    }

    // 手动切换：把会话钉到指定账号（可选顺带解除它的冷却）。
    const disposeSwitch = ctx.webServer.register({
      kind: 'exact',
      path: SWITCH_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'switch 只接受 POST' })
            return
          }
          const input = await readJsonBody(req)
          const sessionId = typeof input.session === 'string' ? input.session : ''
          const accountId = String(input.accountId ?? '')
          if (sessionId === '') throw new Error('缺少会话 id')
          const account = config.allAccounts.find((item) => item.id === accountId)
          if (account === undefined) throw new Error(`没有账号 ${accountId}`)
          if (account.enabled === false) throw new Error(`账号 ${account.label} 已停用，先启用再切换`)
          state.pinSession(sessionId, accountId, 'manual')
          if (input.clearCooldown === true) state.clearCooldown(accountId)
          logger?.info?.(`[opencode-go-pool] 手动切换：${account.label}（会话 ${sessionId.slice(0, 12)}…）`)
          sendJson(res, 200, buildSnapshot(sessionId))
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    // 解除冷却：把某个号从冷却里放出来（用户手动确认「它其实还能用」）。
    const disposeClearCooldown = ctx.webServer.register({
      kind: 'exact',
      path: CLEAR_COOLDOWN_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'clear-cooldown 只接受 POST' })
            return
          }
          const input = await readJsonBody(req)
          const accountId = String(input.accountId ?? '')
          const account = config.allAccounts.find((item) => item.id === accountId)
          if (account === undefined) throw new Error(`没有账号 ${accountId}`)
          const before = state.cooldown(accountId)
          state.clearCooldown(accountId)
          logger?.info?.(`[opencode-go-pool] 手动解除冷却：${account.label}${before === undefined ? '（本来就没冷却）' : ''}`)
          sendJson(res, 200, buildSnapshot(typeof input.session === 'string' ? input.session : undefined))
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    // 拉取最新模型：官方 /zen/go/v1/models → 合并进 config.json（保序更新，新增追加）。
    const disposeModelsRefresh = ctx.webServer.register({
      kind: 'exact',
      path: MODELS_REFRESH_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'models-refresh 只接受 POST' })
            return
          }
          const account = config.accounts[0]
          if (account === undefined) throw new Error('没有启用中的账号，/models 需要 API key')
          const { key } = await resolveAccountKey(ctx, account)
          const response = await fetch(`${config.baseUrl}/models`, {
            headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': USER_AGENT },
          })
          if (!response.ok) throw new Error(`官方 /models 返回 HTTP ${response.status}`)
          const payload = await response.json()
          const list = Array.isArray(payload?.data) ? payload.data : []
          if (list.length === 0) throw new Error('官方 /models 没有返回任何模型')
          const raw = await readRawConfig()
          const merged = mergeModels(Array.isArray(raw.models) ? raw.models : config.models, list.map(toModelEntry))
          raw.models = merged.models
          const previous = await readFile(CONFIG_PATH, 'utf8').catch(() => undefined)
          await writeRawConfig(raw)
          try {
            config = loadConfig()
            configError = undefined
          } catch (error) {
            if (previous !== undefined) await writeFile(CONFIG_PATH, previous, 'utf8').catch(() => {})
            throw error
          }
          logger?.info?.(`[opencode-go-pool] 模型目录已同步：共 ${merged.summary.total} 个，新增 ${merged.summary.added.length} 个`)
          sendJson(res, 200, { ...buildSnapshot(), refresh: merged.summary })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    usage.start()
    logger?.info?.(`[opencode-go-pool] provider "${config.provider.id}" 已注册，${config.accounts.length} 个账号，预留 ${config.reserveDays} 天`)

    // 本地翻译代理：给论文伴读的 babeldoc 一个「OpenAI 兼容端点」，实际走账号池。
    // 单测里用 DSH_OPENCODE_POOL_NO_PROXY=1 关掉，避免测试进程去抢端口。
    let proxy
    let proxyClosed = false
    if (config.translateProxy?.enabled !== false && process.env.DSH_OPENCODE_POOL_NO_PROXY !== '1') {
      void (async () => {
        try {
          const token = await ensureProxyToken()
          const started = await startPoolProxy({
            ctx,
            getConfig: () => config,
            state,
            usage,
            logger,
            token,
            preferredPort: config.translateProxy?.port ?? 8791,
          })
          if (proxyClosed) {
            await started.close()
            return
          }
          proxy = started
          const preferred = config.translateProxy?.model
          const model = typeof preferred === 'string' && preferred !== '' && config.models.some((entry) => entry.id === preferred)
            ? preferred
            : (config.models[0]?.id ?? '')
          await syncTranslateEndpoint({ storePath: TRANSLATE_STORE_PATH, port: started.port, token, model, logger })
        } catch (error) {
          logger?.warn?.(`[opencode-go-pool] 本地翻译代理未启动（论文伴读的翻译端点仍需手动填）：${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    }

    return () => {
      proxyClosed = true
      void proxy?.close?.()
      usage.stop()
      stopWatch()
      try { registration.dispose() } catch { /* 已释放 */ }
      disposeState()
      disposeRefresh()
      disposeDiag()
      disposeAccounts()
      disposeSwitch()
      disposeClearCooldown()
      disposeModelsRefresh()
      state.dispose()
    }
  }, 'opencode-go-pool: provider + usage routes')
}

export { ConfigError }
