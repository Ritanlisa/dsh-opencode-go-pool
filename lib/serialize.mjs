/**
 * 线上序列化层：DSH 的 provider 中立消息 → OpenAI chat.completions 线格式。
 *
 * 只搬运，不做策略；文本/推理/工具调用/工具结果全保留。
 *
 * 图片：DSH 的 ImageBlock 只带 `attachment`（attachmentId/mediaType/bytes/宽高），
 * 字节要走附件服务取。这里不自己读盘，只调用注入的 `resolveImage(block)`；
 * 拿不到 data URL 时降级成一行占位文字，绝不让整个请求失败。
 */

/**
 * 拼接内容块里的纯文本。
 * @param {unknown} content - 消息内容（数组或字符串）。
 * @returns {string} 文本。
 */
export function flattenText(content) {
  if (Array.isArray(content)) {
    return content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
  }
  return typeof content === 'string' ? content : ''
}

/** 取指定类型的块。 */
function blocksOf(content, type) {
  return Array.isArray(content) ? content.filter((block) => block?.type === type) : []
}

/**
 * 请求里有多少个图片块。
 * @param {Array<object>} messages - DSH 消息。
 * @returns {number} 图片块数量。
 */
export function countImageBlocks(messages) {
  return (messages ?? []).reduce((total, message) => total + blocksOf(message?.content, 'image').length, 0)
}

/** 图片读不到时的占位文字。 */
function imagePlaceholder(block) {
  const attachment = block?.attachment ?? {}
  const name = typeof attachment.name === 'string' && attachment.name !== '' ? attachment.name : attachment.mediaType ?? 'image'
  return `[图片未随请求发送：${name}]`
}

/** 服务端单请求体积上限（网关报的是 64 MiB，这里留 4 MiB 余量）。 */
export const MAX_REQUEST_BYTES = 60 * 1024 * 1024

/** 一次请求里图片 data URL 的总预算；超了就从**最旧**的图片开始省略。 */
export const IMAGE_BUDGET_BYTES = 20 * 1024 * 1024

/** 被体积预算裁掉的图片占位。 */
const IMAGE_DROPPED_TEXT = '[图片已省略：为控制请求体大小，历史图片不再随请求发送]'

/** 请求体连同消息一起超出体积上限时抛的错。 */
export class RequestBodyTooLargeError extends Error {
  constructor(bytes) {
    super(`请求体 ${(bytes / 1024 / 1024).toFixed(1)} MiB，超过网关 64 MiB 上限`)
    this.name = 'RequestBodyTooLargeError'
    this.code = 'REQUEST_TOO_LARGE'
    this.bytes = bytes
  }
}

/**
 * 给历史图片分配体积预算：从**最新**往最旧分配，最新的图最有用。
 * @param {Array<object>} messages - DSH 消息。
 * @param {number} budgetBytes - 图片总预算（data URL 估算字节）。
 * @returns {Set<object>} 保留下来的 image block。
 */
export function allocateImageBudget(messages, budgetBytes = IMAGE_BUDGET_BYTES) {
  const images = []
  for (const message of messages ?? []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'image') images.push(block)
    }
  }
  const kept = new Set()
  let left = budgetBytes
  for (let index = images.length - 1; index >= 0; index -= 1) {
    const bytes = Number(images[index]?.attachment?.bytes)
    // base64 约 4/3 原始字节；拿不到原始大小时按 2 MiB 估。
    const estimate = Number.isFinite(bytes) && bytes > 0 ? Math.ceil((bytes * 4) / 3) + 256 : 2 * 1024 * 1024
    if (estimate <= left) {
      kept.add(images[index])
      left -= estimate
    }
  }
  return kept
}

/** JSON 请求体的实际字节数。 */
export function requestBodyBytes(body) {
  return Buffer.byteLength(JSON.stringify(body))
}

/**
 * 把 user 消息序列化成线格式内容（纯文本时给字符串，带图时给数组）。
 * @param {object} message - DSH 消息。
 * @param {(block: object) => Promise<string|undefined>} [resolveImage] - 图片 → data URL。
 * @param {Set<object>|undefined} [keepImages] - 允许保留的 image block；不在集合里的省略。
 * @returns {Promise<string|Array<object>>} content。
 */
async function userContent(message, resolveImage, keepImages) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text') {
      if (typeof block.text === 'string' && block.text !== '') parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block?.type === 'image') {
      if (keepImages !== undefined && !keepImages.has(block)) {
        parts.push({ type: 'text', text: IMAGE_DROPPED_TEXT })
        continue
      }
      let url
      if (resolveImage !== undefined) {
        try {
          url = await resolveImage(block)
        } catch {
          url = undefined
        }
      }
      parts.push(url === undefined
        ? { type: 'text', text: imagePlaceholder(block) }
        : { type: 'image_url', image_url: { url } })
    }
  }
  if (parts.length === 0) return ''
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join('')
  return parts
}

/**
 * 序列化消息数组（异步：图片要等附件解析）。
 *
 * 形状对齐 DSH 既有适配器的实测行为：assistant 的工具调用带 reasoning_content
 * 回传（DeepSeek 系模型的思考链续传要求），tool-result 一律降级成 role:"tool"。
 * @param {Array<object>|undefined} messages - DSH 消息。
 * @param {string|undefined} systemPrompt - 系统提示。
 * @param {(block: object) => Promise<string|undefined>} [resolveImage] - 图片解析器。
 * @param {{stripImages?: boolean, imageBudget?: number}} [options] - 体积控制。
 * @returns {Promise<Array<object>>} 线格式消息。
 */
export async function serializeMessages(messages, systemPrompt, resolveImage, options = {}) {
  const keptImages = options.stripImages === true ? new Set() : allocateImageBudget(messages, options.imageBudget ?? IMAGE_BUDGET_BYTES)
  const wire = []
  if (typeof systemPrompt === 'string' && systemPrompt !== '') wire.push({ role: 'system', content: systemPrompt })
  for (const message of messages ?? []) {
    const role = message?.role
    if (role === 'system') {
      const text = flattenText(message.content)
      if (text !== '') wire.push({ role: 'system', content: text })
      continue
    }
    if (role === 'assistant') {
      const text = flattenText(message.content)
      const reasoning = blocksOf(message.content, 'reasoning').map((block) => block.text).join('')
      const toolCalls = blocksOf(message.content, 'tool-call').map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: block.arguments },
      }))
      const entry = { role: 'assistant', content: text }
      if (reasoning !== '') entry.reasoning_content = reasoning
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      wire.push(entry)
      continue
    }
    const toolResults = blocksOf(message.content, 'tool-result')
    const content = await userContent(message, resolveImage, keptImages)
    if (content !== '' || toolResults.length === 0) wire.push({ role: 'user', content })
    for (const result of toolResults) {
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) || '(no output)' })
    }
  }
  return fillOrphanToolResults(wire)
}

/** 上下文压缩省略工具结果时，补进这条占位文本。 */
export const ORPHAN_TOOL_CONTENT = '(该工具结果已被上下文压缩省略)'

/**
 * 给「有 tool_calls 但缺对应 tool 消息」的 assistant 补占位结果。
 *
 * OpenAI 协议要求每条 tool_call 后面必须有同 id 的 tool 消息，否则整轮 400
 * （`An assistant message with 'tool_calls' must be followed by tool messages…`）。
 * DSH 的压缩会裁剪工具结果，但保留 assistant 的 tool_calls，于是请求就悬空了。
 *
 * 补的是**诚实占位**而不是删 tool_calls：删掉会让模型以为自己没调用过工具。
 *
 * @param {Array<object>} wire 线格式消息（就地不改，返回新数组）。
 * @returns {Array<object>}
 */
export function fillOrphanToolResults(wire) {
  const out = []
  for (let i = 0; i < wire.length; i += 1) {
    const message = wire[i]
    out.push(message)
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue

    // 往后扫到下一条 assistant 为止，收集这段里已有的 tool 应答。
    const answered = new Set()
    let j = i + 1
    while (j < wire.length && wire[j]?.role !== 'assistant') {
      if (wire[j]?.role === 'tool' && wire[j].tool_call_id) answered.add(wire[j].tool_call_id)
      j += 1
    }
    const missing = message.tool_calls.map((call) => call?.id).filter((id) => id && !answered.has(id))
    // 占位必须紧跟在 assistant 之后，否则顺序不合法。
    for (const id of missing) out.push({ role: 'tool', tool_call_id: id, content: ORPHAN_TOOL_CONTENT })
  }
  return out
}

/**
 * 序列化工具定义。
 * @param {Array<object>|undefined} tools - DSH 工具 schema 数组。
 * @returns {Array<object>|undefined} 线格式工具；没有时 undefined。
 */
export function serializeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

/**
 * 生成请求体（异步：图片需要解析成 data URL）。
 *
 * 体积控制（网关硬上限 64 MiB）：
 * 1. 图片总预算 `IMAGE_BUDGET_BYTES`，超了从最旧的图片开始省略；
 * 2. 组装完仍超 `MAX_REQUEST_BYTES` → 去掉**全部**图片重建；
 * 3. 还超（纯文本历史太大）→ 抛 `RequestBodyTooLargeError`，由上层提示压缩会话。
 *
 * @param {object} input - { model, messages, system, tools, maxTokens, temperature, stop, effort, resolveImage, stripImages }。
 * @returns {Promise<object>} JSON 请求体。
 */
export async function buildRequestBody(input) {
  const build = async (options) => {
    const wireTools = serializeTools(input.tools)
    return {
      model: input.model,
      messages: await serializeMessages(input.messages, input.system, input.resolveImage, options),
      stream: true,
      stream_options: { include_usage: true },
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(Array.isArray(input.stop) && input.stop.length > 0 ? { stop: input.stop } : {}),
      ...(wireTools !== undefined ? { tools: wireTools, tool_choice: 'auto' } : {}),
      ...(input.effort !== undefined ? { reasoning_effort: input.effort } : {}),
    }
  }

  const baseOptions = input.imageBudget === undefined ? {} : { imageBudget: input.imageBudget }
  const body = await build({ ...baseOptions, stripImages: input.stripImages === true })
  if (input.stripImages === true) {
    const bytes = requestBodyBytes(body)
    if (bytes > MAX_REQUEST_BYTES) throw new RequestBodyTooLargeError(bytes)
    return body
  }
  if (requestBodyBytes(body) <= MAX_REQUEST_BYTES) return body

  // 超了：去掉全部图片再来一次（文本历史保持完整）。
  const stripped = await build({ ...baseOptions, stripImages: true })
  const bytes = requestBodyBytes(stripped)
  if (bytes > MAX_REQUEST_BYTES) throw new RequestBodyTooLargeError(bytes)
  return stripped
}
