/**
 * 单测：评分公式、选号策略、配置规范化、消息序列化、SSE 翻译、出站身份头。
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OpenCodeGoAdapter, describeError } from '../lib/adapter.mjs'
import { DEFAULT_MODEL, normalizeConfig } from '../lib/config.mjs'
import { USER_AGENT, inferenceRequestHeaders, sessionHeaders, usageRequestHeaders } from '../lib/identity.mjs'
import { chooseAccount, scoreOf } from '../lib/pool.mjs'
import { serializeMessages, buildRequestBody, countImageBlocks } from '../lib/serialize.mjs'
import { translate, mapFinishReason, mapUsage } from '../lib/sse.mjs'
import { StateStore } from '../lib/state.mjs'

// 单测不许写到真实的 ~/.dsh/opencode-go-pool（失败留档会落盘），全部导向临时目录。
process.env.OPENCODE_GO_POOL_DIR = mkdtempSync(join(tmpdir(), 'ogpool-unit-'))

const DAY = 86400000

/** 造一份用量。 */
function usage(percent, daysLeft, status = 'ok') {
  return { monthly: { status, percent, resetsAt: Date.now() + daysLeft * DAY }, weekly: { percent: 0 }, rolling: { percent: 0 } }
}

test('scoreOf：闲且临近重置的号分数更高', () => {
  const now = Date.now()
  const a = scoreOf({ monthly: { percent: 20, resetsAt: now + 10 * DAY } }, 3.5, now)
  const b = scoreOf({ monthly: { percent: 80, resetsAt: now + 10 * DAY } }, 3.5, now)
  const c = scoreOf({ monthly: { percent: 20, resetsAt: now + 20 * DAY } }, 3.5, now)
  assert.ok(a > b, '用量低的更高')
  assert.ok(a > c, '更早重置的更高')
  assert.equal(a, 0.8 / 6.5)
})

test('scoreOf：边界语义', () => {
  const now = Date.now()
  assert.equal(scoreOf({ monthly: { percent: 100, resetsAt: now + DAY } }, 3.5, now), 0, '打满记 0')
  assert.equal(scoreOf({ monthly: { percent: 50, resetsAt: now + 2 * DAY } }, 3.5, now), Number.POSITIVE_INFINITY, '预留窗口内记 ∞')
  assert.ok(Number.isNaN(scoreOf(undefined, 3.5, now)), '无数据 NaN')
  assert.equal(scoreOf({ monthly: { percent: 0 } }, 3.5, now), 1 / 26.5, '缺 resetsAt 保守按 30 天减预留')
})

test('chooseAccount：会话钉号优先，耗尽后换号', () => {
  const now = Date.now()
  const accounts = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ]
  const table = new Map([
    ['a', { monthly: { percent: 60, resetsAt: now + 20 * DAY } }],
    ['b', { monthly: { percent: 10, resetsAt: now + 5 * DAY } }],
    ['c', { monthly: { percent: 30, resetsAt: now + 15 * DAY } }],
  ])
  const pins = new Map([['s1', 'a']])
  const state = {
    sessionAccount: (sid) => pins.get(sid),
    pinSession: (sid, id) => pins.set(sid, id),
  }
  const cooldownOf = () => undefined
  const usageOf = (id) => table.get(id)
  const config = { reserveDays: 3.5 }

  const first = chooseAccount({ accounts, usageOf, cooldownOf, config, sessionId: 's1', state, now })
  assert.equal(first.account.id, 'a', '钉住的号健康就沿用')
  assert.equal(first.reused, true)

  // a 用满 → 必须换到剩下的最高分号（b: 0.9/1.5=0.6，c: 0.7/11.5≈0.06）
  table.set('a', { monthly: { percent: 100, resetsAt: now + 20 * DAY } })
  const second = chooseAccount({ accounts, usageOf, cooldownOf, config, sessionId: 's1', state, now })
  assert.equal(second.account.id, 'b')
  assert.equal(second.reason, 'failover')

  // 全部打满/冷却时仍给一个「最早恢复」的号，让请求发出并由上游报错
  for (const id of ['a', 'b', 'c']) table.set(id, { monthly: { percent: 100, resetsAt: now + DAY } })
  const third = chooseAccount({ accounts, usageOf, cooldownOf, config, sessionId: 's2', state, now })
  assert.ok(third.account !== undefined)
  assert.equal(third.reason, 'fallback-all-exhausted')
})

test('chooseAccount：冷却中的号被跳过', () => {
  const accounts = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  const usageOf = () => ({ monthly: { percent: 10, resetsAt: Date.now() + 10 * DAY } })
  const cooldownOf = (id) => (id === 'a' ? Date.now() + 60000 : undefined)
  const pick = chooseAccount({
    accounts, usageOf, cooldownOf, config: { reserveDays: 3.5 }, sessionId: 'x', state: { sessionAccount: () => undefined }, exclude: undefined,
  })
  assert.equal(pick.account.id, 'b')
})

test('normalizeConfig：账号数量不设上限，支持 1 个', () => {
  const one = normalizeConfig({ accounts: [{ id: 'solo', apiKeyEnv: 'K' }] })
  assert.equal(one.accounts.length, 1)
  const many = normalizeConfig({ accounts: Array.from({ length: 7 }, (_, i) => ({ id: `g${i}`, apiKeyEnv: `K${i}` })) })
  assert.equal(many.accounts.length, 7)
  assert.throws(() => normalizeConfig({ accounts: [{ id: 'x' }] }), /apiKeyEnv/)
  assert.throws(() => normalizeConfig({ accounts: [{ id: 'x', apiKeyEnv: 'K' }, { id: 'x', apiKeyEnv: 'J' }] }), /重复/)
})

test('normalizeConfig：没有 accounts 时从凭据引用自动生成', () => {
  const config = normalizeConfig({}, { refs: { OPENCODE_GO_API_KEY: 'a', OPENCODE_GO_2_API_KEY: 'b', OTHER: 'c' } })
  assert.equal(config.accounts.length, 2)
  assert.equal(config.accounts[0].apiKeyEnv, 'OPENCODE_GO_API_KEY')
})

test('serializeMessages：工具调用与工具结果往返', async () => {
  const wire = await serializeMessages([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":1}' },
      ],
    },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
  ], 'SYS')
  assert.deepEqual(wire[0], { role: 'system', content: 'SYS' })
  assert.deepEqual(wire[1], { role: 'user', content: 'hi' })
  assert.equal(wire[2].reasoning_content, 'think')
  assert.equal(wire[2].tool_calls[0].id, 'c1')
  assert.deepEqual(wire[3], { role: 'tool', tool_call_id: 'c1', content: 'ok' })
})

test('serializeMessages：图片转 image_url，读不到时降级成占位文字', async () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 79, width: 16, height: 16, name: 'red.png' } },
      { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/jpeg', bytes: 10, width: 4, height: 4 } },
    ],
  }]
  const resolved = []
  const wire = await serializeMessages(messages, undefined, async (block) => {
    resolved.push(block.attachment.attachmentId)
    return block.attachment.attachmentId === 'a1' ? 'data:image/png;base64,AAAA' : undefined
  })
  assert.equal(resolved.length, 2, '两张图都应尝试解析')
  assert.equal(wire.length, 1)
  const parts = wire[0].content
  assert.ok(Array.isArray(parts), '带图消息必须走数组形式')
  assert.deepEqual(parts[0], { type: 'text', text: '看图' })
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
  assert.equal(parts[2].type, 'text')
  assert.match(parts[2].text, /图片未随请求发送/)

  // 没有解析器时也不能抛错：图片全部降级成文字，整条消息退回字符串形式
  const plain = await serializeMessages(messages, undefined, undefined)
  assert.equal(typeof plain[0].content, 'string')
  assert.match(plain[0].content, /看图/)
  assert.equal((plain[0].content.match(/图片未随请求发送/g) ?? []).length, 2)
})

test('countImageBlocks', () => {
  assert.equal(countImageBlocks([{ role: 'user', content: [{ type: 'image', attachment: {} }] }]), 1)
  assert.equal(countImageBlocks([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]), 0)
})

test('buildRequestBody：装载工具与推理档位', async () => {
  const body = await buildRequestBody({
    model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], system: 'S',
    tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }], maxTokens: 100, effort: 'max',
  })
  assert.equal(body.stream, true)
  assert.equal(body.reasoning_effort, 'max')
  assert.equal(body.tools[0].function.name, 'f')
  assert.equal(body.max_tokens, 100)
})

test('mapFinishReason / mapUsage', () => {
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' })
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' })
  const mapped = mapUsage({ prompt_tokens: 120, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 3 }, opencode: { allowance: 0.5 } })
  assert.deepEqual(mapped.usage, { inputTokens: 100, outputTokens: 7, cacheReadTokens: 20, reasoningTokens: 3 })
  assert.equal(mapped.allowance, 0.5)
})

test('translate：增量事件 + 收尾顺序 + 空响应报错', async () => {
  async function* payloads() {
    yield JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] })
    yield JSON.stringify({ choices: [{ delta: { content: '你' } }] })
    yield JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, opencode: { allowance: 0.01 } } })
  }
  const chunks = []
  let recorded
  for await (const chunk of translate(payloads(), (info) => { recorded = info })) chunks.push(chunk)
  const types = chunks.map((chunk) => chunk.type)
  assert.deepEqual(types.slice(0, 4), ['block-start', 'reasoning-delta', 'block-start', 'text-delta'])
  assert.equal(types.at(-1), 'finish')
  assert.deepEqual(chunks.find((chunk) => chunk.type === 'finish').reason, { kind: 'stop' })
  const text = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block).find((block) => block.type === 'text')
  assert.equal(text.text, '你好')
  assert.equal(recorded.allowance, 0.01)

  // 回归：后续分片把 name / id 显式写成 null（OpenAI 兼容服务的常见写法）。
  // 曾经用 `!== undefined` 判断，导致 null 被透传成 name:null，
  // DSH 的流校验直接抛 TypeError: tool-call-delta name must be a string。
  async function* nullName() {
    yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'echo', arguments: '{"a"' } }] } }] })
    yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: ':1}' } }] } }] })
    yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  }
  const nullChunks = []
  for await (const chunk of translate(nullName())) nullChunks.push(chunk)
  const nullDeltas = nullChunks.filter((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(nullDeltas.length, 2, '两段 delta 都要产出')
  for (const delta of nullDeltas) {
    assert.equal(typeof delta.id, 'string', 'id 必须是字符串')
    if (Object.hasOwn(delta, 'name')) assert.equal(typeof delta.name, 'string', 'name 必须缺席或为字符串')
  }
  const toolBlock = nullChunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)[0]
  assert.equal(toolBlock.name, 'echo', 'null 不应覆盖已记住的工具名')
  assert.equal(toolBlock.arguments, '{"a":1}', '参数照常拼装')

  async function* empty() { yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) }
  const emptyChunks = []
  for await (const chunk of translate(empty())) emptyChunks.push(chunk)
  const finish = emptyChunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('identity：UA 用自己的 product token，且不是通用 SDK/HTTP 库名', () => {
  assert.match(USER_AGENT, /^opencode-go-pool\/\d+\.\d+\.\d+ \(\+https:\/\/\S+\)$/)
  assert.doesNotMatch(USER_AGENT, /\b(node|undici|axios|curl|python-requests|go-http-client)\b/i)
  // 用量请求与推理请求必须是同一个客户端身份
  assert.equal(usageRequestHeaders('k')['user-agent'], USER_AGENT)
  assert.equal(inferenceRequestHeaders({ apiKey: 'k', sessionId: 's' })['user-agent'], USER_AGENT)
})

test('sessionHeaders：两个会话头同值，缺 id 时落兜底，坏值不污染头', () => {
  const both = sessionHeaders('session-abc', 'fallback-1')
  assert.deepEqual(both, {
    'x-opencode-session': 'session-abc',
    'x-deepseek-harness-session-id': 'session-abc',
  })
  const fallback = sessionHeaders(undefined, 'fallback-1')
  assert.equal(fallback['x-opencode-session'], 'fallback-1')
  assert.equal(fallback['x-deepseek-harness-session-id'], 'fallback-1')
  // CR/LF 不能进头值：这种值视为不可用，退回兜底 id
  const sanitized = sessionHeaders('bad\r\nX-Evil: 1', 'fallback-2')
  assert.equal(sanitized['x-opencode-session'], 'fallback-2')
  // 两个都不可用才抛
  assert.throws(() => sessionHeaders(undefined, undefined), /会话头/)
})

test('inferenceRequestHeaders：coding agent 的常规头 + 授权', () => {
  const headers = inferenceRequestHeaders({ apiKey: 'secret-key', sessionId: 'session-1' })
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal(headers.authorization, 'Bearer secret-key')
  assert.equal(headers['x-opencode-session'], 'session-1')
  assert.equal(headers['x-deepseek-harness-session-id'], 'session-1')
})

test('StateStore：兜底会话 id 落盘，跨实例（重启）稳定', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ogpool-state-')), 'state.json')
  const first = new StateStore(file)
  const id = first.fallbackSession()
  assert.match(id, /^dsh-opencode-go-pool-[0-9a-f-]{36}$/)
  assert.equal(first.fallbackSession(), id, '同一实例重复取必须一致')
  first.dispose()

  const second = new StateStore(file)
  assert.equal(second.fallbackSession(), id, '重启后必须还是同一个 id（否则缓存桶全冷）')
  second.dispose()
})

test('StateStore：缓存命中量进入本地用量计', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ogpool-state-')), 'state.json')
  const store = new StateStore(file)
  store.addLocal('go-1', { usd: 0.01, inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 })
  store.addLocal('go-1', { usd: 0.01, inputTokens: 200, outputTokens: 10, cacheReadTokens: 0 })
  const local = store.local('go-1')
  assert.equal(local.input, 300)
  assert.equal(local.cacheRead, 900)
  assert.equal(local.cacheHits, 1, '只有真命中那次算命中请求')
  assert.equal(local.requests, 2)
  store.dispose()
})

/** 造一个只依赖内存状态的适配器（不会碰网络：fetch 在用例里替换）。 */
function makeTestAdapter(recorded, overrides = {}, cooldowns = []) {
  const usage = {
    monthly: { percent: 0, resetsAt: Date.now() + DAY },
    rolling: { percent: 0 },
    weekly: { percent: 0 },
  }
  const config = {
    provider: { id: 'opencode-go', name: 'OpenCode Go' },
    baseUrl: 'https://opencode.ai/zen/go/v1',
    reserveDays: 3.5,
    requestTimeoutMs: 180000,
    maxFailoverAttempts: 1,
    retryBackoffMs: 10,
    models: [DEFAULT_MODEL],
    accounts: [{ id: 'go-1', label: 'Go 1', apiKey: 'inline-key', enabled: true }],
    ...overrides,
  }
  return new OpenCodeGoAdapter({
    ctx: {},
    getConfig: () => config,
    state: {
      sessionAccount: () => undefined,
      pinSession: () => {},
      cooldown: () => undefined,
      setCooldown: (id, until) => cooldowns.push({ id, until }),
      clearCooldown: () => {},
      addLocal: (id, delta) => recorded.push({ id, ...delta }),
      fallbackSession: () => 'fallback-session-for-test',
    },
    usage: { refresh: async () => usage, usage: () => usage },
    logger: undefined,
  })
}

test('adapter：推理请求带自家 UA + 两个同值会话头，并把 cacheReadTokens 记账', async () => {
  const captured = []
  const originalFetch = globalThis.fetch
  const payload = JSON.stringify({
    choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 }, opencode: { allowance: 0.001 } },
  })
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), init })
    return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const recorded = []
  try {
    const adapter = makeTestAdapter(recorded)
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'session-adapter-test',
    })) chunks.push(chunk)

    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, 'https://opencode.ai/zen/go/v1/chat/completions')
    const headers = captured[0].init.headers
    assert.equal(captured[0].init.method, 'POST')
    assert.equal(headers['x-opencode-session'], 'session-adapter-test')
    assert.equal(headers['x-deepseek-harness-session-id'], 'session-adapter-test', '原生头必须同值发出')
    assert.equal(headers['user-agent'], USER_AGENT)
    assert.equal(headers.accept, 'text/event-stream')
    assert.equal(headers.authorization, 'Bearer inline-key')
    const body = JSON.parse(captured[0].init.body)
    assert.equal(body.stream, true, 'coding agent 走流式')
    assert.equal(recorded[0].cacheReadTokens, 80, '命中量要进本地记账')
    assert.ok(chunks.some((chunk) => chunk.type === 'finish'))

    // 没有 sessionId 时，两个头都落到同一个稳定兜底 id（不能变成随机值）
    for await (const _chunk of adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) { /* 消费完流 */ }
    const fallbackHeaders = captured[1].init.headers
    assert.equal(fallbackHeaders['x-opencode-session'], 'fallback-session-for-test')
    assert.equal(fallbackHeaders['x-deepseek-harness-session-id'], 'fallback-session-for-test')
  } finally {
    globalThis.fetch = originalFetch
  }
})

/** 429 的响应体（模拟网关限流）。 */
function rateLimitResponse() {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit', message: 'too many requests' } }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一段最小可用的流式成功响应。 */
function okStreamResponse() {
  const payload = JSON.stringify({
    choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 1, opencode: { allowance: 0.0001 } },
  })
  return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

test('adapter：429 后在时间窗内退避重试，成功就不再报错', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return calls === 1 ? rateLimitResponse() : okStreamResponse()
  }
  try {
    const recorded = []
    const adapter = makeTestAdapter(recorded, { maxFailoverAttempts: 1, retryBackoffMs: 10 })
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'session-retry-test',
    })) chunks.push(chunk)
    assert.equal(calls, 2, '一次 429 后应自动重试一次，而不是直接打掉整轮')
    const finish = chunks.find((chunk) => chunk.type === 'finish')
    assert.deepEqual(finish.reason, { kind: 'stop' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('adapter：持续 429 时也只重试一轮，然后抛出可读错误', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return rateLimitResponse()
  }
  try {
    const recorded = []
    const adapter = makeTestAdapter(recorded, { maxFailoverAttempts: 1, retryBackoffMs: 10 })
    let error
    try {
      for await (const _chunk of adapter.stream({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        sessionId: 'session-retry-fail',
      })) { /* 消费完 */ }
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== undefined, '两轮都失败必须报错')
    assert.equal(error.code, 'RATE_LIMIT')
    assert.match(error.message, /被限流|HTTP 429/)
    assert.equal(calls, 2, '1 账号 × 2 轮 = 2 次请求，不许无限重试')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('describeError：把 fetch failed 的 cause 链展开成可读文本', () => {
  const inner = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
    code: 'ECONNREFUSED',
    errno: -4078,
    syscall: 'connect',
    address: '1.2.3.4',
    port: 443,
  })
  const outer = new TypeError('fetch failed', { cause: inner })
  const text = describeError(outer)
  assert.match(text, /fetch failed/)
  assert.match(text, /ECONNREFUSED/)
  assert.match(text, /syscall=connect/)
  assert.match(text, /port=443/)
})

test('adapter：连接类失败多试一轮且只做短冷却（不再锁 3 分钟）', async () => {
  const originalFetch = globalThis.fetch
  const cooldowns = []
  let calls = 0
  const refused = () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
      code: 'ECONNREFUSED', errno: -4078, syscall: 'connect',
    })
    return new TypeError('fetch failed', { cause: inner })
  }
  globalThis.fetch = async () => {
    calls += 1
    if (calls <= 2) throw refused()
    return okStreamResponse()
  }
  try {
    const recorded = []
    const adapter = makeTestAdapter(recorded, { maxFailoverAttempts: 1, retryBackoffMs: 10 }, cooldowns)
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'session-transport',
    })) chunks.push(chunk)
    assert.ok(calls >= 3, `应当重试到成功，实际 ${calls} 次`)
    assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
    // 网络错误与账号无关：不写冷却，只在本轮内避开该号。
    assert.equal(cooldowns.length, 0, '连接类失败不应冷却账号')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('chooseAccount：兜底时优先挑没打满的号，绝不落到已打满的号', () => {
  const now = Date.now()
  const accounts = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  const usageOf = (id) => (id === 'a'
    ? { monthly: { percent: 100, resetsAt: now + 2 * DAY } }
    : { monthly: { percent: 50, resetsAt: now + 10 * DAY } })
  const cooldownOf = (id) => (id === 'b' ? now + 3000 : undefined)
  const state = { sessionAccount: () => undefined, pinSession: () => {} }
  const pick = chooseAccount({ accounts, usageOf, cooldownOf, config: { reserveDays: 3.5 }, sessionId: 's1', state, now })
  assert.equal(pick.reason, 'fallback-usable-cooling')
  assert.equal(pick.account.id, 'b', '要发到没打满的 b，而不是已打满的 a')
})

test('chooseAccount：全部打满才落到 fallback-all-exhausted', () => {
  const now = Date.now()
  const accounts = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  const usageOf = () => ({ monthly: { percent: 100, resetsAt: now + 5 * DAY } })
  const pick = chooseAccount({
    accounts, usageOf, cooldownOf: () => undefined, config: { reserveDays: 3.5 }, sessionId: 's2',
    state: { sessionAccount: () => undefined },
  })
  assert.equal(pick.reason, 'fallback-all-exhausted')
})

/** 造一个「go-1 已打满 + go-2 正常但可能冷却」的适配器。 */
function makeTwoAccountAdapter({ cooldownOf, usageById, recorded = [], cooldownSink }) {
  return new OpenCodeGoAdapter({
    ctx: {},
    getConfig: () => ({
      provider: { id: 'opencode-go', name: 'OpenCode Go' },
      baseUrl: 'https://opencode.ai/zen/go/v1',
      reserveDays: 3.5, requestTimeoutMs: 180000, maxFailoverAttempts: 1, retryBackoffMs: 10,
      models: [DEFAULT_MODEL],
      accounts: [
        { id: 'go-1', label: 'Go 1', apiKey: 'k1', enabled: true },
        { id: 'go-2', label: 'Go 2', apiKey: 'k2', enabled: true },
      ],
    }),
    state: {
      sessionAccount: () => undefined,
      pinSession: () => {},
      cooldown: cooldownOf,
      setCooldown: (id, until) => {
        if (cooldownSink !== undefined) cooldownSink[id] = until
      },
      clearCooldown: () => {},
      addLocal: (id, delta) => recorded.push({ id, ...delta }),
      fallbackSession: () => 'fb',
    },
    usage: { refresh: async () => undefined, usage: (id) => usageById[id] },
    logger: undefined,
  })
}

test('adapter：没打满的号在冷却时直接用它（不等），绝不发给已打满的号', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return okStreamResponse()
  }
  const now = Date.now()
  const usageById = {
    'go-1': { monthly: { percent: 100, resetsAt: now + 2 * DAY }, rolling: { percent: 0 }, weekly: { percent: 0 } },
    'go-2': { monthly: { percent: 40, resetsAt: now + 10 * DAY }, rolling: { percent: 0 }, weekly: { percent: 0 } },
  }
  const cooldowns = { 'go-1': now + 60000, 'go-2': now + 60000 }
  const adapter = makeTwoAccountAdapter({
    cooldownOf: (id) => (cooldowns[id] !== undefined && cooldowns[id] > Date.now() ? cooldowns[id] : undefined),
    usageById,
  })
  try {
    const startedAt = Date.now()
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'session-wait',
    })) chunks.push(chunk)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.headers.authorization, 'Bearer k2', '要发到没打满的 go-2，不能是 go-1')
    assert.ok(Date.now() - startedAt < 5000, '语义是「直接发出去」，不引入等待')
    assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('adapter：本轮可用号都试过时轮转重试，期间绝不碰已打满的号', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  let attempt = 0
  globalThis.fetch = async (url, init) => {
    calls.push(init.headers.authorization)
    attempt += 1
    if (attempt <= 2) {
      const inner = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
      throw new TypeError('fetch failed', { cause: inner })
    }
    return okStreamResponse()
  }
  const now = Date.now()
  const usageById = {
    'go-1': { monthly: { percent: 100, resetsAt: now + 2 * DAY }, rolling: { percent: 0 }, weekly: { percent: 0 } },
    'go-2': { monthly: { percent: 40, resetsAt: now + 10 * DAY }, rolling: { percent: 0 }, weekly: { percent: 0 } },
  }
  const adapter = new OpenCodeGoAdapter({
    ctx: {},
    getConfig: () => ({
      provider: { id: 'opencode-go', name: 'OpenCode Go' },
      baseUrl: 'https://opencode.ai/zen/go/v1',
      reserveDays: 3.5, requestTimeoutMs: 180000, maxFailoverAttempts: 2, retryBackoffMs: 10,
      models: [DEFAULT_MODEL],
      accounts: [
        { id: 'go-1', label: 'Go 1', apiKey: 'k1', enabled: true },
        { id: 'go-2', label: 'Go 2', apiKey: 'k2', enabled: true },
      ],
    }),
    state: {
      sessionAccount: () => undefined,
      pinSession: () => {},
      cooldown: () => undefined,
      setCooldown: () => {},
      clearCooldown: () => {},
      addLocal: () => {},
      fallbackSession: () => 'fb',
    },
    usage: { refresh: async () => undefined, usage: (id) => usageById[id] },
    logger: undefined,
  })
  try {
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'session-all-tried',
    })) chunks.push(chunk)
    assert.ok(calls.length >= 3, '应当轮转重试到成功')
    assert.ok(calls.every((auth) => auth === 'Bearer k2'), '所有请求都该发给 go-2，绝不碰已打满的 go-1')
    assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('serializeMessages：压缩裁掉工具结果时补占位，绝不留下悬空 tool_calls', async () => {
  // 真机 400 的复现形状：assistant 有 2 个 tool_call，但第二个结果被压缩裁掉。
  const msg = (role, content) => ({ role, content })
  const wire = await serializeMessages([
    msg('user', [{ type: 'text', text: '跑一下' }]),
    msg('assistant', [
      { type: 'text', text: '我来跑' },
      { type: 'tool-call', id: 'call_a', name: 'ops_bash', arguments: '{}' },
      { type: 'tool-call', id: 'call_b', name: 'ops_bash', arguments: '{}' },
    ]),
    msg('user', [{ type: 'tool-result', toolCallId: 'call_a', content: [{ type: 'text', text: 'ok' }] }]),
  ])
  const idx = wire.findIndex((m) => m.role === 'assistant')
  assert.ok(idx >= 0)
  const after = wire.slice(idx + 1)
  const toolMsgs = after.filter((m) => m.role === 'tool')
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['call_b', 'call_a'], '占位要在前，真实结果在后')
  assert.equal(toolMsgs[0].content, '(该工具结果已被上下文压缩省略)')
  assert.equal(toolMsgs[1].content, 'ok')
})

test('serializeMessages：结果齐全时不插占位', async () => {
  const wire = await serializeMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }] },
  ])
  const tools = wire.filter((m) => m.role === 'tool')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].content, 'x')
})

test('adapter：请求非法（tool_calls 缺 tool 消息）不得被当成额度问题冷却账号', () => {
  const now = Date.now()
  const cooldowns = {}
  const state = {
    sessionAccount: () => undefined,
    pinSession: () => {},
    cooldown: (id) => cooldowns[id],
    setCooldown: (id, until) => { cooldowns[id] = until },
    clearCooldown: () => {},
  }
  const adapter = new OpenCodeGoAdapter({
    getConfig: () => ({ accounts: [{ id: 'go-3', label: 'Go 3' }], reserveDays: 3.5, models: [] }),
    state,
    usage: { usage: () => undefined, refresh: async () => undefined },
    logger: { warn: () => {}, info: () => {} },
  })
  const snippet = JSON.stringify({
    error: {
      type: 'invalid_request_error',
      message: "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls)",
    },
  })
  return adapter.onFailure({ id: 'go-3', label: 'Go 3' }, 400, snippet).then(({ code }) => {
    assert.notEqual(code, 'quota', '不能判成额度不足')
    assert.equal(cooldowns['go-3'], undefined, '健康的号不该被打进冷却')
    assert.ok(Date.now() - now < 5000)
  })
})

test('adapter：请求非法时只打一个号就上报，不把其余账号拖下水', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls)",
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }
  const cooldowns = {}
  const adapter = makeTwoAccountAdapter({
    cooldownOf: () => undefined,
    usageById: {
      'go-1': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY }, rolling: { percent: 1 }, weekly: { percent: 1 } },
      'go-2': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY }, rolling: { percent: 1 }, weekly: { percent: 1 } },
    },
    cooldownSink: cooldowns,
  })
  try {
    let error
    try {
      for await (const _chunk of adapter.stream({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        sessionId: 'session-bad-shape',
      })) { /* 消费 */ }
    } catch (caught) { error = caught }
    assert.ok(error !== undefined, '应当上抛错误')
    assert.equal(error.code, 'PROVIDER_ERROR')
    assert.equal(calls.length, 1, '只应请求一次，不换号重试')
    assert.deepEqual(Object.keys(cooldowns), [], '不得把账号打进冷却')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('adapter：网络错误不冷却账号（同一台机器连同一网关，跟账号无关）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }) }
  const cooldowns = {}
  const adapter = makeTwoAccountAdapter({
    cooldownOf: () => undefined,
    usageById: {
      'go-1': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY }, rolling: { percent: 1 }, weekly: { percent: 1 } },
      'go-2': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY }, rolling: { percent: 1 }, weekly: { percent: 1 } },
    },
    cooldownSink: cooldowns,
  })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 400)
  try {
    try {
      for await (const _chunk of adapter.stream({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        sessionId: 'session-transport',
        signal: controller.signal,
      })) { /* 消费 */ }
    } catch { /* 预期被中止 */ }
    assert.deepEqual(Object.keys(cooldowns), [], '网络错误不得写冷却')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('adapter：网络抖动几轮后恢复则整轮成功（不因一次 ECONNRESET 打掉回合）', async () => {
  const originalFetch = globalThis.fetch
  let attempt = 0
  globalThis.fetch = async () => {
    attempt += 1
    if (attempt <= 2) throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' })
    return okStreamResponse()
  }
  const adapter = makeTwoAccountAdapter({
    cooldownOf: () => undefined,
    usageById: {
      'go-1': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY }, rolling: { percent: 1 }, weekly: { percent: 1 } },
      'go-2': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY }, rolling: { percent: 1 }, weekly: { percent: 1 } },
    },
  })
  try {
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'session-jitter',
    })) chunks.push(chunk)
    assert.ok(attempt >= 3, `应当重试过，实际 ${attempt} 次`)
    assert.ok(chunks.some((chunk) => chunk.type === 'finish'), '最终应当成功')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('adapter：连接类错误不设轮数上限，抖动 8 轮后仍能成功', async () => {
  const originalFetch = globalThis.fetch
  let attempt = 0
  globalThis.fetch = async () => {
    attempt += 1
    if (attempt <= 8) throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' })
    return okStreamResponse()
  }
  const adapter = makeTwoAccountAdapter({
    cooldownOf: () => undefined,
    usageById: {
      'go-1': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY }, rolling: { percent: 1 }, weekly: { percent: 1 } },
      'go-2': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY }, rolling: { percent: 1 }, weekly: { percent: 1 } },
    },
  })
  try {
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'session-long-jitter',
    })) chunks.push(chunk)
    assert.ok(attempt > 5, `必须超过旧的 5 轮上限，实际 ${attempt} 次`)
    assert.ok(chunks.some((chunk) => chunk.type === 'finish'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('adapter：无限重试必须能被调用方中止（不能卡死无法取消）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }) }
  const controller = new AbortController()
  const adapter = makeTwoAccountAdapter({
    cooldownOf: () => undefined,
    usageById: {
      'go-1': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY }, rolling: { percent: 1 }, weekly: { percent: 1 } },
      'go-2': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY }, rolling: { percent: 1 }, weekly: { percent: 1 } },
    },
  })
  try {
    const startedAt = Date.now()
    setTimeout(() => controller.abort(), 300)
    let error
    try {
      for await (const _chunk of adapter.stream({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        sessionId: 'session-abort',
        signal: controller.signal,
      })) { /* 消费 */ }
    } catch (caught) { error = caught }
    assert.ok(error !== undefined, '中止后应当抛错而不是一直挂着')
    assert.ok(Date.now() - startedAt < 5000, '中止应当很快生效')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('adapter：地区限制（403 RegionError）是模型级错误，不冷却账号', () => {
  const cooldowns = {}
  const adapter = new OpenCodeGoAdapter({
    getConfig: () => ({ accounts: [{ id: 'go-3', label: 'Go 3' }], reserveDays: 3.5, models: [] }),
    state: {
      sessionAccount: () => undefined, pinSession: () => {},
      cooldown: (id) => cooldowns[id], setCooldown: (id, until) => { cooldowns[id] = until },
      clearCooldown: () => {},
    },
    usage: { usage: () => undefined, refresh: async () => undefined },
    logger: { warn: () => {}, info: () => {} },
  })
  const snippet = JSON.stringify({ type: 'error', error: { type: 'RegionError', message: 'This model is not available in your country' } })
  return adapter.onFailure({ id: 'go-3', label: 'Go 3' }, 403, snippet).then(({ code, error }) => {
    assert.equal(code, 'model')
    assert.equal(error.code, 'MODEL_UNAVAILABLE')
    assert.equal(cooldowns['go-3'], undefined, '地区限制是模型级问题，不该冷却账号')
  })
})

test('adapter：工作区隐私限制（400 trains on request data）是模型级错误，不冷却账号', () => {
  const cooldowns = {}
  const adapter = new OpenCodeGoAdapter({
    getConfig: () => ({ accounts: [{ id: 'go-2', label: 'Go 2' }], reserveDays: 3.5, models: [] }),
    state: {
      sessionAccount: () => undefined, pinSession: () => {},
      cooldown: (id) => cooldowns[id], setCooldown: (id, until) => { cooldowns[id] = until },
      clearCooldown: () => {},
    },
    usage: { usage: () => undefined, refresh: async () => undefined },
    logger: { warn: () => {}, info: () => {} },
  })
  const snippet = JSON.stringify({ error: { type: 'invalid_request_error', message: 'This OpenCode Go model trains on request data, which is disabled for your workspace.' } })
  return adapter.onFailure({ id: 'go-2', label: 'Go 2' }, 400, snippet).then(({ code, error }) => {
    assert.equal(code, 'model')
    assert.equal(error.code, 'MODEL_UNAVAILABLE')
    assert.equal(cooldowns['go-2'], undefined, '隐私设置是模型级问题，不该冷却账号')
    assert.match(error.message, /隐私/)
  })
})

test('adapter：模型级错误只发一次请求就上报，不换号重试', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'RegionError', message: 'This model is not available in your country' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )
  }
  const cooldowns = {}
  const adapter = makeTwoAccountAdapter({
    cooldownOf: () => undefined,
    usageById: {
      'go-1': { monthly: { percent: 100, resetsAt: Date.now() + 5 * DAY } },
      'go-2': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY } },
    },
    cooldownSink: cooldowns,
  })
  try {
    let error
    try {
      for await (const _chunk of adapter.stream({
        model: 'muse-spark-1.2-contributor',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        sessionId: 'session-model-error',
      })) { /* 消费 */ }
    } catch (caught) { error = caught }
    assert.ok(error !== undefined)
    assert.equal(error.code, 'MODEL_UNAVAILABLE')
    assert.equal(calls.length, 1, '模型级错误换号也没用，只该发一次')
    assert.deepEqual(cooldowns, {}, '不该把健康的号打进冷却')
  } finally {
    globalThis.fetch = originalFetch
  }
})

/** 造一张带原始字节数的 image block（不需要真实附件服务）。 */
function fakeImage(bytes) {
  return { type: 'image', attachment: { bytes, mediaType: 'image/png', name: 'shot.png' } }
}

test('serialize：图片总预算超了只保留最新的，旧的降级成占位文字', async () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'a' }, fakeImage(3 * 1024 * 1024)] },
    { role: 'user', content: [{ type: 'text', text: 'b' }, fakeImage(3 * 1024 * 1024)] },
    { role: 'user', content: [{ type: 'text', text: 'c' }, fakeImage(3 * 1024 * 1024)] },
  ]
  const resolveImage = async () => 'data:image/png;base64,AAAA'
  // 每张 base64 约 4 MiB，预算 5 MiB → 只够最新的那张。
  const wire = await serializeMessages(messages, undefined, resolveImage, { imageBudget: 5 * 1024 * 1024 })
  const flat = JSON.stringify(wire)
  assert.equal((flat.match(/data:image\/png/g) ?? []).length, 1, '只该留最新的 1 张图')
  assert.equal((flat.match(/图片已省略/g) ?? []).length, 2, '旧的两张要降级成占位文字')
})

test('serialize：stripImages 去掉全部图片，保留文本', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: '看图' }, fakeImage(1024)] }]
  const body = await buildRequestBody({
    model: 'm',
    messages,
    stripImages: true,
    resolveImage: async () => 'data:image/png;base64,AAAA',
  })
  const flat = JSON.stringify(body)
  assert.ok(!flat.includes('data:image'), '不该再带 data URL')
  assert.ok(flat.includes('图片已省略'), '要有占位说明')
  assert.ok(flat.includes('看图'), '文本要保留')
})

test('adapter：HTTP 413 时去掉图片重建请求再发一次（不冷却账号、不换号干赔）', async () => {
  const originalFetch = globalThis.fetch
  const bodies = []
  let call = 0
  globalThis.fetch = async (url, init) => {
    bodies.push(String(init.body ?? ''))
    call += 1
    if (call === 1) {
      return new Response(
        JSON.stringify({ error: { message: 'Request bodies must be at most 64 MiB. Please reduce the length of the messages or attachments, or run compaction.', type: 'invalid_request_error', code: 'context_length_exceeded' } }),
        { status: 413, headers: { 'content-type': 'application/json' } },
      )
    }
    return okStreamResponse()
  }
  const cooldowns = {}
  const adapter = makeTwoAccountAdapter({
    cooldownOf: () => undefined,
    usageById: {
      'go-1': { monthly: { percent: 90, resetsAt: Date.now() + 5 * DAY } },
      'go-2': { monthly: { percent: 10, resetsAt: Date.now() + 5 * DAY } },
    },
    cooldownSink: cooldowns,
  })
  adapter.resolveImage = async () => 'data:image/png;base64,AAAABBBB'
  try {
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, fakeImage(1024)] }],
      sessionId: 'session-413',
    })) chunks.push(chunk)
    assert.equal(bodies.length, 2, '应当重发一次')
    assert.ok(bodies[0].includes('data:image'), '第一次带图')
    assert.ok(!bodies[1].includes('data:image'), '413 之后必须去掉图片')
    assert.ok(chunks.some((chunk) => chunk.type === 'finish'), '重发后应当正常结束')
    assert.deepEqual(cooldowns, {}, '请求体太大跟账号无关，不该冷却')
  } finally {
    globalThis.fetch = originalFetch
  }
})
