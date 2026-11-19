/**
 * 本地 OpenAI 兼容代理：把 babeldoc / 其它第三方客户端的 `chat.completions` 请求
 * 转给 OpenCode Go 账号池（自动选号 + 额度失败换号），再把上游响应原样透传。
 *
 * 为什么需要它：论文伴读的翻译走 babeldoc 子进程，只能吃「OpenAI 兼容端点 + key + 模型」，
 * 没法直接调用 DSH 的 provider 适配器。有了这个本地端点，翻译端点填一次
 * `http://127.0.0.1:<port>/v1` 就能享受账号池的轮换与额度管理。
 *
 * 安全：只监听 127.0.0.1，且要求 `Authorization: Bearer <token>`；token 由插件随机生成、
 * 落盘在 ~/.dsh/opencode-go-pool/proxy-token（0600），只写进论文伴读的 translate.json。
 */
import { Buffer } from 'node:buffer'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { dirname } from 'node:path'

import { chooseAccount } from './pool.mjs'
import { inferenceRequestHeaders } from './identity.mjs'

/** 单次请求体上限（翻译请求通常几 KB，留足附件的余量）。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** 论文伴读 translate.json 里我们写入的端点 id。 */
const ENDPOINT_ID = 'opencode-go-pool'
/** 429 之后把账号冷却多久（翻译是长跑，短冷却就够）。 */
const RATE_COOLDOWN_MS = 60 * 1000

/** JSON 响应小工具。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 常量时间比较 Bearer token。 */
function authorized(req, token) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const value = header.startsWith('Bearer ') ? header.slice(7) : ''
  const left = Buffer.from(value)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** 读请求体，超过上限直接拒绝。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 启动本地代理。
 * @param {object} input - { ctx, getConfig, state, usage, logger, token, preferredPort }。
 * @returns {Promise<{port: number, close: () => Promise<void>}>} 实际监听端口与关闭函数。
 */
export async function startPoolProxy({
  ctx,
  getConfig,
  state,
  usage,
  logger,
  token,
  preferredPort = 8791,
  hostname = '127.0.0.1',
  upstreamFetch = fetch,
  maxPortTries = 10,
}) {
  const cooldowns = new Map()
  const cfg = () => getConfig()

  const usageOf = (id) => (typeof usage?.usage === 'function' ? usage.usage(id) : undefined)
  const cooldownOf = (id) => {
    const until = state?.cooldown?.(id) ?? cooldowns.get(id)
    if (until === undefined) return undefined
    if (until <= Date.now()) {
      cooldowns.delete(id)
      state?.clearCooldown?.(id)
      return undefined
    }
    return until
  }

  /** 一次补全请求：选号 → 转发 → 透传；可恢复失败就换下一个号。 */
  const completions = async (req, res) => {
    let payload
    try {
      payload = JSON.parse(await readBody(req))
    } catch (error) {
      sendJson(res, 400, { error: { message: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, type: 'invalid_request_error' } })
      return
    }
    const config = cfg()
    const model = typeof payload?.model === 'string' ? payload.model : ''
    if (!config.models.some((entry) => entry.id === model)) {
      sendJson(res, 400, {
        error: {
          message: `模型 "${model}" 不在账号池目录里；可用：${config.models.map((entry) => entry.id).slice(0, 8).join(', ')}…`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      })
      return
    }

    // 会话头固定成「代理 + 模型」：同一模型的所有翻译请求命中同一条缓存线。
    const proxySession = `pool-proxy-${model}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120)
    const excluded = new Set()
    const attempts = Math.max(config.maxFailoverAttempts ?? 3, 1)
    let lastStatus = 0
    let lastDetail = ''

    for (let step = 0; step < attempts; step += 1) {
      const pick = chooseAccount({
        accounts: config.accounts,
        usageOf,
        cooldownOf,
        config,
        sessionId: proxySession,
        state,
        exclude: excluded,
      })
      const account = pick.account
      if (account === undefined) break
      excluded.add(account.id)

      let key
      try {
        const resolved = await ctx.credentials?.resolve?.(account.apiKeyEnv)
        key = typeof resolved?.value === 'string' && resolved.value !== '' ? resolved.value : undefined
      } catch { key = undefined }
      if (key === undefined) {
        lastDetail = `账号 ${account.label} 的凭据解析失败`
        continue
      }

      let upstream
      try {
        upstream = await upstreamFetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: inferenceRequestHeaders({
            apiKey: key,
            sessionId: proxySession,
            fallbackSession: state?.fallbackSession?.(),
          }),
          body: JSON.stringify(payload),
        })
      } catch (error) {
        lastDetail = `账号 ${account.label} 连接失败：${error instanceof Error ? error.message : String(error)}`
        continue
      }

      if (!upstream.ok) {
        lastStatus = upstream.status
        lastDetail = `账号 ${account.label} 返回 HTTP ${upstream.status}`
        await upstream.text().catch(() => '')
        if (upstream.status === 429) {
          state?.setCooldown?.(account.id, Date.now() + RATE_COOLDOWN_MS)
          cooldowns.set(account.id, Date.now() + RATE_COOLDOWN_MS)
        }
        continue
      }

      // 成功：透传状态与响应体（流式/非流式都适用）。
      state?.clearCooldown?.(account.id)
      cooldowns.delete(account.id)
      const contentType = upstream.headers.get('content-type') ?? 'application/json'
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
      try {
        for await (const chunk of upstream.body) res.write(chunk)
      } catch (error) {
        logger?.warn?.(`[opencode-go-pool] 代理透传中断：${error instanceof Error ? error.message : String(error)}`)
      }
      res.end()
      return
    }

    sendJson(res, lastStatus >= 400 ? lastStatus : 502, {
      error: { message: `账号池没有可用账号：${lastDetail || '全部冷却或额度用尽'}`, type: 'pool_unavailable' },
    })
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy.local')
    if (!authorized(req, token)) {
      sendJson(res, 401, { error: { message: '缺少或错误的本地代理 token', type: 'invalid_request_error' } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const config = cfg()
      sendJson(res, 200, {
        object: 'list',
        data: config.models.map((model) => ({ id: model.id, object: 'model', owned_by: 'opencode-go-pool' })),
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      try {
        await completions(req, res)
      } catch (error) {
        logger?.warn?.(`[opencode-go-pool] 本地代理处理失败：${error instanceof Error ? error.message : String(error)}`)
        if (!res.headersSent) sendJson(res, 500, { error: { message: String(error), type: 'proxy_error' } })
        else res.end()
      }
      return
    }
    sendJson(res, 404, { error: { message: `未知路径 ${url.pathname}`, type: 'invalid_request_error' } })
  }

  const server = createServer((req, res) => { void handler(req, res) })
  server.on('clientError', (_error, socket) => { try { socket.destroy() } catch { /* 已关闭 */ } })

  let boundPort
  for (let offset = 0; offset < maxPortTries; offset += 1) {
    const port = preferredPort + offset
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error) }
        const onListening = () => { server.off('error', onError); resolve() }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, hostname)
      })
      boundPort = port
      break
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
    }
  }
  if (boundPort === undefined) throw new Error(`本地代理端口 ${preferredPort}..${preferredPort + maxPortTries - 1} 全被占用`)

  logger?.info?.(`[opencode-go-pool] 本地翻译代理已监听 http://${hostname}:${boundPort}/v1`)
  return {
    port: boundPort,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * 把本地代理写进论文伴读的 `translate.json`，让它「开箱即用」不用手填。
 *
 * 只在该文件还没有任何端点、或者现有的就是我们的（或已选中我们）时才接管；
 * 用户手填过的端点一律不动，避免替用户改配置。
 *
 * @param {{storePath: string, port: number, token: string, model: string, logger?: object}} input - 目标文件与代理参数。
 * @returns {Promise<'written'|'kept-user'|'skipped'>} 处理结果。
 */
export async function syncTranslateEndpoint({ storePath, port, token, model, logger }) {
  if (typeof storePath !== 'string' || storePath === '') return 'skipped'
  if (typeof model !== 'string' || model === '') return 'skipped'
  let store = { activeId: null, endpoints: [] }
  try {
    const parsed = JSON.parse(await readFile(storePath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      store = {
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
        endpoints: Array.isArray(parsed.endpoints)
          ? parsed.endpoints.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
          : [],
      }
    }
  } catch { /* 没配过 */ }

  const others = store.endpoints.filter((entry) => entry.id !== ENDPOINT_ID)
  const hadOurs = store.endpoints.some((entry) => entry.id === ENDPOINT_ID)
  const shouldOwn = others.length === 0 || hadOurs || store.activeId === ENDPOINT_ID
  if (!shouldOwn) {
    logger?.info?.('[opencode-go-pool] 论文伴读已有手填的翻译端点，保留不动')
    return 'kept-user'
  }

  const next = {
    activeId: ENDPOINT_ID,
    endpoints: [
      ...others,
      {
        id: ENDPOINT_ID,
        label: 'OpenCode Go 账号池（自动）',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: token,
        model,
      },
    ],
  }
  await mkdir(dirname(storePath), { recursive: true })
  const tmp = `${storePath}.tmp`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => {})
  await rename(tmp, storePath)
  await chmod(storePath, 0o600).catch(() => {})
  logger?.info?.(`[opencode-go-pool] 论文伴读翻译端点已指向本地账号池代理：http://127.0.0.1:${port}/v1`)
  return 'written'
}
