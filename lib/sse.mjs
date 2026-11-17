/**
 * SSE 解析与流翻译：OpenAI 兼容 chunk → DSH 的 StreamChunk 协议。
 *
 * 顺序契约（对齐 dsh-llm-deepseek 的实测行为）：增量事件随到随发；
 * block-end / usage / finish 全部推迟到 [DONE]，且 finish 之后不再发任何块；
 * 空响应（stop 但一个块都没开）按 EMPTY_RESPONSE 报错，而不是静默成功。
 */

/** [DONE] 哨兵。 */
const DONE = '[DONE]'
/** 空响应的机器码（DSH 约定的 code 字面量）。 */
const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/** 空响应错误。 */
export class EmptyResponseError extends Error {
  constructor() {
    super('model returned a completed response with no content')
    this.name = 'EmptyResponseError'
    this.code = EMPTY_RESPONSE_CODE
  }
}

/**
 * 逐行解析 SSE，产出 data 载荷（不含 [DONE]）。
 * @param {Response} response - fetch 响应（带 body 流）。
 * @returns {AsyncGenerator<string>} data 载荷。
 */
export async function* parseSse(response) {
  if (response.body === null) throw new Error('response has no body stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '').trim()
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '' || data === DONE) continue
        yield data
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* 取消失败不影响上层 */ }
    reader.releaseLock()
  }
}

/**
 * 映射 finish_reason。
 * @param {string} reason - 线格式 finish_reason。
 * @returns {object} DSH FinishReason。
 */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } }
  }
}

/**
 * 映射 usage（DSH 约定：input 与 cacheRead 不重叠）。
 * @param {object} usage - 线格式 usage。
 * @returns {{usage: object, allowance: number, opencode: object|undefined}} 归一化用量。
 */
export function mapUsage(usage) {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens
  const opencode = usage?.opencode
  return {
    usage: {
      inputTokens: Math.max((usage?.prompt_tokens ?? 0) - cacheRead, 0),
      outputTokens: usage?.completion_tokens ?? 0,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
    },
    allowance: typeof opencode?.allowance === 'number' ? opencode.allowance : 0,
    opencode: opencode ?? undefined,
  }
}

/** 关掉一个累积块，生成最终 ContentBlock。 */
function closeBlock(block) {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    default: return { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text }
  }
}

/**
 * 把 SSE 载荷翻译成 StreamChunk。
 * @param {AsyncIterable<string>} payloads - parseSse 的输出。
 * @param {(info: {usage?: object, allowance: number, opencode?: object}) => void} [onComplete] - 收尾回调（记账用）。
 * @returns {AsyncGenerator<object>} StreamChunk 序列。
 */
export async function* translate(payloads, onComplete) {
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage
  let allowance = 0
  let opencode

  function open(kind) {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      const error = new Error(`malformed SSE payload: ${payload.slice(0, 120)}`)
      error.code = 'MALFORMED_RESPONSE'
      throw error
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice?.delta ?? {}
      const reasoning = delta.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (block === undefined) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        // 只接受真正的字符串：OpenAI 兼容服务在后续分片里常把 name / id 写成 null，
        // 而 DSH 的流校验对「存在但不是字符串」的 name 会直接抛
        // TypeError: tool-call-delta name must be a string。
        if (typeof call.id === 'string' && call.id.length > 0) block.callId = call.id
        if (typeof call.function?.name === 'string' && call.function.name.length > 0) block.name = call.function.name
        const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: typeof block.callId === 'string' ? block.callId : '',
          ...(typeof block.name === 'string' ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }

      if (typeof choice?.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }

    if (chunk.usage !== undefined && chunk.usage !== null) {
      const mapped = mapUsage(chunk.usage)
      pendingUsage = mapped.usage
      allowance = mapped.allowance
      opencode = mapped.opencode
    }
  }

  // 载荷自然结束（没等到 [DONE] 也照样收尾；上层用 response.ok 已确认成功）。
  for (const block of order) {
    yield { type: 'block-end', index: block.index, block: closeBlock(block) }
  }
  if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
  onComplete?.({ usage: pendingUsage, allowance, opencode })
  const reason = pendingFinish ?? { kind: 'stop' }
  if (reason.kind === 'stop' && order.length === 0) {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } } }
    return
  }
  yield { type: 'finish', reason }
}
