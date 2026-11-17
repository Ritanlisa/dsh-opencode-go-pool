/**
 * LLM 适配器：把「一个提供商 + N 个 OpenCode Go 账号」做成一个模型选择项。
 *
 * 一次请求的决策链：
 *   1. 取用量（缓存 60s，冷启动最多等 2.5s）；
 *   2. 会话已钉号且该号健康 → 沿用（保上下文/缓存一致性）；
 *   3. 否则按 score 选最高分号并钉住；
 *   4. 请求失败按类型分流：鉴权失败/额度耗尽/限流 → 冷却该号、换下一个；
 *      流已经开始吐字之后再失败就不再换号（避免重复输出），直接抛给上层。
 *
 * 响应里的 usage.opencode.allowance 会累计进本地用量计，作为曲线之外的补充证据。
 */
import { resolveAccountKey } from './api-keys.mjs'
import { recordError } from './errorlog.mjs'
import { inferenceRequestHeaders } from './identity.mjs'
import { chooseAccount, isExhausted } from './pool.mjs'
import { buildRequestBody, countImageBlocks } from './serialize.mjs'
import { parseSse, translate } from './sse.mjs'
/** 冷启动时等用量数据的上限。 */
const USAGE_WAIT_MS = 2500
/** 空闲超时：这么久没有任何 chunk 就认为连接死了。 */
const IDLE_TIMEOUT_MS = 180000
/** 发给模型的图片长边上限（超了让附件服务缩放，省 allowance）。 */
const MAX_IMAGE_EDGE = 2048
/** 单张图片编码后的字节上限。 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
/** 图片 data URL 缓存条数（同一会话多轮会反复带历史图，别每轮重编码）。 */
const IMAGE_CACHE_ENTRIES = 24

/** 鉴权类失败冷却 30 分钟。 */
const AUTH_COOLDOWN_MS = 30 * 60 * 1000
/** 普通限流冷却 3 分钟。 */
const RATE_COOLDOWN_MS = 3 * 60 * 1000
/**
 * 连接类失败（DNS/连接重置/本机网络抖动）冷却：15 秒。
 * 这种失败跟账号没关系，按 3 分钟冷却会把三个号一起锁死，用户看到「全部冷却」。
 */
/** 一轮账号全失败后，最多再来几轮（限流/5xx）。 */
const MAX_ROUNDS = 2
/** 第二轮前的默认退避（毫秒）；config.retryBackoffMs 可覆盖。 */
const DEFAULT_RETRY_BACKOFF_MS = 2500
/** 重试的总时间预算：超过就认命报错，别让用户等太久。 */
const RETRY_WINDOW_MS = 30000
/** 流已经开始吐字后断开：只把这个号短暂避开，避免下一轮又立刻撞上同一个坏连接。 */
const MID_STREAM_COOLDOWN_MS = 20 * 1000

/** sleep 小工具。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 给异步迭代器套一个空闲超时：每个元素都会重置计时器。
 * @param {AsyncIterable} source - 源迭代器。
 * @param {number} idleMs - 空闲毫秒数。
 * @param {() => void} onIdle - 超时回调（一般是 abort）。
 * @returns {AsyncGenerator} 包装后的迭代器。
 */
async function* withIdleTimeout(source, idleMs, onIdle) {
  let timer
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(onIdle, idleMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  try {
    arm()
    for await (const item of source) {
      arm()
      yield item
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 构造带 code 的适配器错误。 */
function adapterError(message, code, status) {
  const error = new Error(message)
  error.code = code
  if (status !== undefined) error.status = status
  return error
}

/**
 * 把 fetch 的 `TypeError: fetch failed` 展开成真正的原因链。
 * undici 只把「connect ECONNREFUSED / ENOTFOUND / ECONNRESET / UND_ERR_SOCKET」这些
 * 细节放在 `error.cause` 里，只看 message 永远只有一句 fetch failed。
 * @param {unknown} error - 捕获到的错误。
 * @returns {string} 形如 `TypeError fetch failed <- Error connect ECONNREFUSED 1.2.3.4:443`。
 */
export function describeError(error) {
  const parts = []
  let current = error
  let depth = 0
  while (current !== undefined && current !== null && depth < 4) {
    const bits = []
    if (current.name !== undefined) bits.push(String(current.name))
    if (current.code !== undefined) bits.push(`code=${current.code}`)
    if (current.errno !== undefined) bits.push(`errno=${current.errno}`)
    if (current.syscall !== undefined) bits.push(`syscall=${current.syscall}`)
    if (current.address !== undefined) bits.push(`address=${current.address}`)
    if (current.port !== undefined) bits.push(`port=${current.port}`)
    if (current.message !== undefined) bits.push(String(current.message).slice(0, 200))
    if (bits.length > 0) parts.push(bits.join(' '))
    current = typeof current === 'object' ? current.cause : undefined
    depth += 1
  }
  return parts.length > 0 ? parts.join(' <- ') : String(error)
}

/**
 * 这类失败值得在时间窗内重试一轮：限流、上游 5xx、连接抖动。
 * 鉴权失败/额度打满/请求本身非法都不重试（重试只会更糟）。
 * @param {Error|undefined} error - 上一轮的错误。
 * @returns {boolean} 是否可重试。
 */
function isTransientFailure(error) {
  const code = error?.code
  return code === 'RATE_LIMIT' || code === 'SERVER' || code === 'TRANSPORT'
}

export class OpenCodeGoAdapter {
  /**
   * @param {object} options - { ctx, getConfig, state, usage, logger }。
   */
  constructor({ ctx, getConfig, state, usage, logger }) {
    this.ctx = ctx
    this.getConfig = getConfig
    this.state = state
    this.usage = usage
    this.logger = logger
    /** 图片 data URL 缓存（attachmentId+目标尺寸 → data URL）。 */
    this.imageCache = new Map()
  }

  /** 提供商展示信息。 */
  providerInfo(provider) {
    const config = this.getConfig()
    return { id: provider, name: config.provider.name }
  }

  /** 重试策略：适配器自己换号，关闭外层重试，避免双重重试放大额度消耗。 */
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: [],
      initialDelayMs: 500,
      maxDelayMs: 5000,
      jitterRatio: 0.1,
    }
  }

  /**
   * 绑定一次调用的适配器代际（DSH 0.2.x 契约）：
   * 运行时先要 model 元数据，再通过返回的 stream 分发，保证「解析能力」和「真正发请求」
   * 用的是同一代适配器。基类就是这两步，插件里必须显式提供——运行时直接调 adapter.prepareCall。
   */
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) }
  }

  /** 图片请求计费：Go 的响应自带 allowance，不走本地图片估算。 */
  imageRequestPricing() {
    return undefined
  }

  /**
   * 图片请求目标：长边超过 2048 就让附件服务等比缩小，编码字节再压到 2MB 以内。
   * （附件服务按「长边 + 字节上限」派生确定性变体，这里只给目标。）
   */
  imageRequestTarget(_provider, _model, image) {
    const width = Number.isFinite(image?.width) && image.width > 0 ? image.width : 1024
    const height = Number.isFinite(image?.height) && image.height > 0 ? image.height : 1024
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height))
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      maxBytes: Math.min(Number.isFinite(image?.bytes) && image.bytes > 0 ? image.bytes : MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
    }
  }

  /**
   * 把一张图解析成 data URL（带缓存）。
   *
   * 走官方附件服务的 `readImageRequest(ref, target, signal)`：它按 route 目标尺寸/字节
   * 派生确定性变体（带磁盘缓存），返回 { data, mediaType, ... }。
   * @param {object} block - DSH 的 image 块（带 attachment）。
   * @param {string} provider - 提供商 route。
   * @param {string} model - 模型 id。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<string|undefined>} data URL；拿不到返回 undefined（调用方降级成占位文字）。
   */
  async resolveImage(block, provider, model, signal) {
    const attachment = block?.attachment
    if (attachment === undefined || attachment === null) return undefined
    const attachments = typeof this.ctx.get === 'function' ? this.ctx.get('attachments') : undefined
    if (attachments === undefined || typeof attachments.readImageRequest !== 'function') return undefined

    const target = this.imageRequestTarget(provider, model, attachment)
    const key = `${attachment.attachmentId}|${target.width}x${target.height}|${target.maxBytes}`
    const cached = this.imageCache.get(key)
    if (cached !== undefined) return cached
    const version = await attachments.readImageRequest(attachment, target, signal)
    if (version === undefined || version === null || version.data === undefined) return undefined
    const mediaType = typeof version.mediaType === 'string' ? version.mediaType : attachment.mediaType ?? 'image/png'
    const base64 = Buffer.from(version.data).toString('base64')
    const url = `data:${mediaType};base64,${base64}`
    if (this.imageCache.size >= IMAGE_CACHE_ENTRIES) {
      const oldest = this.imageCache.keys().next().value
      if (oldest !== undefined) this.imageCache.delete(oldest)
    }
    this.imageCache.set(key, url)
    return url
  }

  /** 模型声明的输入模态（缺省按多模态处理）。 */
  modalitiesOf(model) {
    return Array.isArray(model?.input) && model.input.length > 0 ? [...model.input] : ['text', 'image']
  }

  /** 模型目录（来自配置，稳定可预期）。 */
  async listModels(provider) {
    const config = this.getConfig()
    return config.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      description: `${config.provider.name} · ${config.accounts.length} 个账号自动选号`,
      inputModalities: this.modalitiesOf(model),
    }))
  }

  /** 解析单个模型的元数据（上下文、默认输出上限、推理档位）。 */
  async resolveModel(provider, model, _signal) {
    const config = this.getConfig()
    const found = config.models.find((entry) => entry.id === model) ?? config.models[0]
    return {
      provider,
      id: model,
      name: found.id === model ? found.name : model,
      inputModalities: this.modalitiesOf(found),
      context: { contextWindow: found.contextWindow },
      defaultMaxTokens: found.maxTokens,
      reasoning: {
        efforts: Object.keys(found.efforts).map((id) => ({
          id,
          name: id === 'off' ? 'Off' : id.charAt(0).toUpperCase() + id.slice(1),
          description: id === 'off' ? '不思考，最省额度' : id === 'max' ? '极限思考，最费额度' : `思考强度 ${id}`,
        })),
        defaultEffort: found.defaultEffort,
      },
    }
  }

  /** 冷启动等一会儿用量数据，避免「没数据 → 全 NaN → 随便选」。 */
  async warmUsage(config) {
    const pending = Promise.allSettled(config.accounts.map((account) => this.usage.refresh(account)))
    await Promise.race([pending, sleep(USAGE_WAIT_MS)])
  }

  /** 选号 + 钉住，返回账号。 */
  async pickAccount(config, sessionId, exclude) {
    // 本轮「没打满」的号如果都被试过了，先清空排除集重新轮转：
    // 否则 chooseAccount 会落到已打满（100%）的号上——发出去也必然吃额度错误。
    // 只换候选，不加等待：保持「选一个号发出去，由上游返回真实错误」的语义。
    if (exclude !== undefined && exclude.size > 0) {
      const usable = config.accounts.filter((account) => !isExhausted(this.usage.usage(account.id)))
      if (usable.length > 0 && usable.every((account) => exclude.has(account.id))) exclude.clear()
    }
    const pick = chooseAccount({
      accounts: config.accounts,
      usageOf: (id) => this.usage.usage(id),
      cooldownOf: (id) => this.state.cooldown(id),
      config,
      sessionId,
      state: this.state,
      exclude,
    })
    if (pick.account !== undefined && sessionId !== undefined) {
      this.state.pinSession(sessionId, pick.account.id, pick.reason)
    }
    return pick
  }

  /**
   * 失败分流：冷却账号、必要时拉一次用量确认是不是月额度打满。
   * @param {object} account - 出问题的账号。
   * @param {number} status - HTTP 状态。
   * @param {string} bodyText - 响应体片段。
   * @returns {{error: Error, code: string}} 归一化错误。
   */
  async onFailure(account, status, bodyText) {
    const snippet = String(bodyText ?? '').slice(0, 300)
    // 地区/工作区限制是**模型级**错误：换账号也一样被拒，所以不冷却账号、也不换号重试。
    if (status === 403 && /RegionError|not available in your country|not available in your region|地区/i.test(snippet)) {
      return {
        error: adapterError(`该模型在当前网络/地区不可用（HTTP 403）：${snippet}`, 'MODEL_UNAVAILABLE', status),
        code: 'model',
      }
    }
    // 工作区隐私设置拦下的模型（会训练请求数据的那些）也是**模型级**错误：
    // 换账号没用、更不该把号冷却掉，让用户去 Console › Settings › Privacy 打开即可。
    if (status === 400 && /trains? on (request|your)|train(ing)? on request data|请求数据.*训练/i.test(snippet)) {
      return {
        error: adapterError(`该模型被工作区隐私设置挡住（HTTP 400，需要 Console › Settings › Privacy 打开「允许会训练请求数据的付费端点」）：${snippet}`, 'MODEL_UNAVAILABLE', status),
        code: 'model',
      }
    }
    if (status === 401 || status === 403) {
      this.state.setCooldown(account.id, Date.now() + AUTH_COOLDOWN_MS)
      return { error: adapterError(`账号 ${account.label} 鉴权失败（HTTP ${status}）`, 'AUTH', status), code: 'auth' }
    }
    if (status === 402 || status === 429) {
      const usage = await this.usage.refresh(account, { force: true }).catch(() => undefined)
      const resetsAt = usage?.monthly?.resetsAt
      const exhausted = (usage?.monthly?.percent ?? 0) >= 100
      const until = exhausted && typeof resetsAt === 'number' ? resetsAt : Date.now() + RATE_COOLDOWN_MS
      this.state.setCooldown(account.id, until)
      const code = exhausted ? 'QUOTA' : 'RATE_LIMIT'
      return { error: adapterError(`账号 ${account.label} ${exhausted ? '月额度已用尽' : '被限流'}（HTTP ${status}）${snippet}`, code, status), code }
    }
    if (status === 413) {
      return {
        error: adapterError(`请求体超过网关 64 MiB 上限（HTTP 413），去掉图片后仍超——请压缩会话后重试：${snippet}`, 'CONTEXT_TOO_LARGE', status),
        code: 'provider',
      }
    }
    if (status >= 500) {
      this.state.setCooldown(account.id, Date.now() + RATE_COOLDOWN_MS)
      return { error: adapterError(`账号 ${account.label} 上游错误（HTTP ${status}）${snippet}`, 'SERVER', status), code: 'server' }
    }
    // 4xx 分两类：额度（换号有效、冷却本号）与请求本身非法（换号无效、不得冷却）。
    // 判据见 test/unit.test.mjs 的「请求非法不冷却账号」用例。
    const REQUEST_SHAPE_HINT = /tool_calls|tool_call_id|must be followed by tool messages|invalid_request_error|insufficient tool messages|messages\b.*\binvalid/i
    if (REQUEST_SHAPE_HINT.test(snippet)) {
      return {
        error: adapterError(
          `账号 ${account.label} 拒绝了请求本身（HTTP ${status}，与额度无关）：${snippet}`,
          'PROVIDER_ERROR',
          status,
        ),
        code: 'provider',
      }
    }
    if (/quota|usage limit|limit exceeded|额度|exceeded|monthly limit|out of credit/i.test(snippet)) {
      this.state.setCooldown(account.id, Date.now() + RATE_COOLDOWN_MS)
      return { error: adapterError(`账号 ${account.label} 额度不足（HTTP ${status}）${snippet}`, 'QUOTA', status), code: 'quota' }
    }
    return { error: adapterError(`账号 ${account.label} 请求失败（HTTP ${status}）${snippet}`, 'PROVIDER_ERROR', status), code: 'provider' }
  }

  /** 成功收尾记账：本地用量计 + 清冷却。 */
  record(account, info) {
    try {
      this.state.clearCooldown(account.id)
      this.state.addLocal(account.id, {
        usd: info.allowance ?? 0,
        inputTokens: info.usage?.inputTokens ?? 0,
        outputTokens: info.usage?.outputTokens ?? 0,
        cacheReadTokens: info.usage?.cacheReadTokens ?? 0,
      })
    } catch { /* 记账失败不影响主链路 */ }
  }

  /**
   * 主入口：流式生成。
   * @param {object} options - GenerateOptions。
   * @returns {AsyncGenerator} StreamChunk。
   */
  async *stream(options) {
    const config = this.getConfig()
    const modelMeta = config.models.find((model) => model.id === options.model) ?? config.models[0]
    const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined
    await this.warmUsage(config)

    const effortKey = options.reasoningEffort
    const effort = effortKey !== undefined && modelMeta.efforts[effortKey] !== undefined
      ? modelMeta.efforts[effortKey]
      : modelMeta.efforts[modelMeta.defaultEffort]

    const images = countImageBlocks(options.messages)
    if (images > 0) {
      this.logger?.info?.(`[opencode-go-pool] 请求含 ${images} 张图片，按 image_url(data URL) 发送`)
    }
    const buildBody = (stripImages) => buildRequestBody({
      model: options.model,
      messages: options.messages,
      system: options.system,
      tools: options.tools,
      maxTokens: options.maxTokens ?? modelMeta.maxTokens,
      temperature: options.temperature,
      stop: options.stop,
      effort,
      stripImages,
      imageBudget: Math.round((config.imageBudgetMiB ?? 20) * 1024 * 1024),
      resolveImage: (block) => this.resolveImage(block, options.provider ?? config.provider.id, options.model, options.signal),
    })
    let body
    try {
      body = await buildBody(false)
    } catch (error) {
      if (error?.code === 'REQUEST_TOO_LARGE') {
        throw adapterError(
          `请求体约 ${(Number(error.bytes ?? 0) / 1048576).toFixed(1)} MiB，超过网关 64 MiB 上限（去掉图片后仍超）——请先压缩会话/删掉超大工具输出再试`,
          'CONTEXT_TOO_LARGE',
        )
      }
      throw error
    }
    // 网关嫌大时只允许「去掉全部图片重建」一次，避免无限循环。
    let strippedImages = false

    const excluded = new Set()
    const attempts = Math.max(config.maxFailoverAttempts, 1)
    const startedAt = Date.now()
    const retryBackoffMs = typeof config.retryBackoffMs === 'number' && Number.isFinite(config.retryBackoffMs)
      ? Math.max(0, config.retryBackoffMs)
      : DEFAULT_RETRY_BACKOFF_MS
    let lastError
    let round = 0

    // 一轮 = 把 attempts 个账号各试一次。一轮全灭且是「限流/5xx/连接」这类可恢复错误时，
    // 退避后清空排除集再来一轮。
    //
    // 连接类错误（ECONNRESET / ConnectTimeout）**不设预算上限**：网络抖动是外部条件，
    // 与其在 30 秒后把整轮判死，不如一直重试到网络恢复；唯一的边界是调用方的 abort
    // （用户取消 / 会话被停）。退避封顶 2 秒，所以观感上就是「一直立即重试」。
    for (let step = 0; ; step += 1) {
      if (step > 0 && step % attempts === 0) {
        if (!isTransientFailure(lastError)) break
        const transport = lastError?.code === 'TRANSPORT'
        if (!transport) {
          if (Date.now() >= startedAt + RETRY_WINDOW_MS) break
          if (round + 1 >= MAX_ROUNDS) break
        }
        if (options.signal?.aborted) throw adapterError('request aborted by caller', 'ABORTED')
        round += 1
        const backoff = retryBackoffMs * 2 ** Math.min(round - 1, 4)
        const wait = transport
          ? Math.min(2000, Math.max(200, backoff))
          : Math.max(200, Math.min(startedAt + RETRY_WINDOW_MS - Date.now(), backoff))
        this.logger?.warn?.(`[opencode-go-pool] 本轮账号全部失败（${lastError?.code}），${wait}ms 后重试`)
        recordError({ kind: 'retry-round', sessionId: sessionId ?? null, code: lastError?.code, message: lastError?.message, waitMs: wait })
        await sleep(wait)
        excluded.clear()
      }
      if (options.signal?.aborted) throw adapterError('request aborted by caller', 'ABORTED')
      const pick = await this.pickAccount(config, sessionId, excluded)
      if (pick.account === undefined) {
        lastError = lastError ?? adapterError('没有可用账号（全部冷却或额度用尽）', 'QUOTA')
        break
      }
      // 还有没打满的号、但都在冷却：等过一小会儿仍没好 → 明确报错，绝不把请求发给已打满的号。
      if (pick.reason === 'cooldown-wait') {
        const waitMs = Math.max(0, (pick.cooldownUntil ?? Date.now()) - Date.now())
        lastError = adapterError(
          `账号池暂时都在冷却（最早约 ${Math.ceil(waitMs / 1000)} 秒后恢复），本次没有把请求发到已打满的账号上`,
          'RATE_LIMIT',
        )
        recordError({
          kind: 'give-up-cooldown',
          sessionId: sessionId ?? null,
          accountId: pick.account.id,
          waitMs,
          message: lastError.message,
        })
        break
      }
      const account = pick.account
      let key
      try {
        const resolved = await resolveAccountKey(this.ctx, account)
        key = resolved.key
      } catch (error) {
        excluded.add(account.id)
        this.state.setCooldown(account.id, Date.now() + AUTH_COOLDOWN_MS)
        lastError = adapterError(error instanceof Error ? error.message : String(error), 'AUTH')
        continue
      }

      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const idle = () => controller.abort(new Error('idle timeout'))
      let emitted = false
      try {
        this.logger?.info?.(`[opencode-go-pool] ${sessionId ?? '(no-session)'} → ${account.label} [${pick.reason}]`)

        // 建连阶段失败（DNS/连接重置/代理）还没吐字 → 换号重来。
        let response
        try {
          response = await fetch(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            // 两个会话头同值：x-opencode-session 是网关的路由亲和 / prompt cache 分桶键
            // （缺了直接 400 MissingSessionID）；x-deepseek-harness-session-id 是 DSH 原生头，
            // OpenCode 用它把请求认成 DSH 客户端、走官方兼容路径。
            headers: inferenceRequestHeaders({
              apiKey: key,
              sessionId,
              fallbackSession: this.state.fallbackSession(),
            }),
            body: JSON.stringify(body),
            signal: controller.signal,
          })
        } catch (error) {
          if (options.signal?.aborted) throw adapterError('request aborted by caller', 'ABORTED')
          excluded.add(account.id)
          // 网络错误跟账号无关（同一台机器连同一个网关），所以**不冷却账号**：
          // 冷却它只会让后续请求无谓地绕开一个健康账号；本轮内靠 excluded 避开即可。
          const detail = describeError(error)
          lastError = adapterError(`账号 ${account.label} 连接失败（网络层，与额度无关）：${detail}`, 'TRANSPORT')
          recordError({
            kind: 'transport',
            sessionId: sessionId ?? null,
            accountId: account.id,
            cause: detail,
            message: lastError.message,
          })
          continue
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          // 网关嫌请求体太大（HTTP 413 / Request bodies must be at most 64 MiB）：
          // 换号没用——同一个 body 还是一样的。去掉全部图片重建一次再发。
          const bodyTooLarge = response.status === 413
            || /Request bodies must be at most|context_length_exceeded|request body too large/i.test(text)
          if (bodyTooLarge && !strippedImages) {
            strippedImages = true
            body = await buildBody(true)
            // 记成 TRANSPORT 只是为了让轮次逻辑允许「马上重发」；跟账号无关，所以不排除、不冷却。
            lastError = adapterError(`请求体超过网关上限（HTTP ${response.status}），已去掉历史图片重试`, 'TRANSPORT')
            this.logger?.warn?.(`[opencode-go-pool] 请求体过大（HTTP ${response.status}），已去掉历史图片重建后重试`)
            recordError({
              kind: 'strip-images',
              sessionId: sessionId ?? null,
              accountId: account.id,
              status: response.status,
              message: text.slice(0, 200),
            })
            continue
          }
          const failure = await this.onFailure(account, response.status, text)
          excluded.add(account.id)
          lastError = failure.error
          recordError({
            kind: 'http',
            sessionId: sessionId ?? null,
            accountId: account.id,
            status: response.status,
            code: failure.code,
            snippet: text.slice(0, 400),
            message: failure.error.message,
          })
          // 请求本身非法（如 tool_calls 缺 tool 消息）：每个号都会同样拒绝，
          // 继续换号只会把健康账号一起打上冷却、并把真实原因埋在别的错误后面。
          if (failure.code === 'provider' || failure.code === 'model') break
          continue
        }

        const stream = translate(
          withIdleTimeout(parseSse(response), IDLE_TIMEOUT_MS, idle),
          (info) => this.record(account, info),
        )
        for await (const chunk of stream) {
          emitted = true
          yield chunk
        }
        return
      } catch (error) {
        if (options.signal?.aborted) throw adapterError('request aborted by caller', 'ABORTED')
        // 已经开始吐字：不能换号重来（会重复输出），直接上抛。
        if (emitted) {
          const midwayError = adapterError(
            `账号 ${account.label} 流中断：${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
          )
          // 只短暂避开这个号：下一轮换号重来，别立刻又撞上同一个坏连接。
          this.state.setCooldown(account.id, Date.now() + MID_STREAM_COOLDOWN_MS)
          recordError({ kind: 'stream-midway', sessionId: sessionId ?? null, accountId: account.id, message: midwayError.message })
          throw midwayError
        }
        excluded.add(account.id)
        lastError = adapterError(
          `账号 ${account.label} 流失败：${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT',
        )
        recordError({ kind: 'stream', sessionId: sessionId ?? null, accountId: account.id, message: lastError.message })
        continue
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
      }
    }

    const giveUp = lastError ?? adapterError('OpenCode Go 请求失败', 'PROVIDER_ERROR')
    recordError({ kind: 'give-up', sessionId: sessionId ?? null, code: giveUp.code, message: giveUp.message })
    throw giveUp
  }
}
