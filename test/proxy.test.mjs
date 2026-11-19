/**
 * 本地翻译代理的集成测试：真起一个 http server + 假上游，验证
 *   - 无 token → 401；模型不在目录 → 400
 *   - 正常请求透传上游 SSE，并带上账号 key 与 x-opencode-session
 *   - 上游 429 → 换下一个账号，被打的号进冷却
 * 运行：node --test test/proxy.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { startPoolProxy } from '../lib/local-proxy.mjs'

const MODELS = [{ id: 'm1', name: 'Model 1' }, { id: 'm2', name: 'Model 2' }]

function makeConfig() {
  return {
    baseUrl: 'https://upstream.test/v1',
    reserveDays: 3.5,
    maxFailoverAttempts: 3,
    models: MODELS,
    accounts: [
      { id: 'go-1', label: 'Go 1', apiKeyEnv: 'KEY_1', enabled: true },
      { id: 'go-2', label: 'Go 2', apiKeyEnv: 'KEY_2', enabled: true },
    ],
    allAccounts: [],
  }
}

function makeState() {
  const cooldowns = new Map()
  return {
    cooldowns,
    sessionAccount: () => undefined,
    pinSession: () => {},
    cooldown: (id) => cooldowns.get(id),
    setCooldown: (id, until) => cooldowns.set(id, until),
    clearCooldown: (id) => cooldowns.delete(id),
    fallbackSession: () => 'fallback-session',
  }
}

/** 假 ctx：按 apiKeyEnv 返回固定 key。 */
const ctx = {
  credentials: {
    resolve: async (ref) => ({ value: ref === 'KEY_1' ? 'sk-key-1' : 'sk-key-2' }),
  },
}

// go-1 用量更低 → 分数更高，选号可预测
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const usage = {
  usage: (id) => (id === 'go-1'
    ? { monthly: { percent: 10, resetsAt: NOW + 10 * DAY } }
    : { monthly: { percent: 20, resetsAt: NOW + 10 * DAY } }),
}

/** 上游 SSE 响应。 */
function sseResponse(text) {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('本地代理：鉴权 / 模型校验 / 透传 / 429 换号', async () => {
  const calls = []
  const responses = [sseResponse('上游答复'), sseResponse('换号后的答复')]
  const upstreamFetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body })
    const next = responses.shift()
    if (next !== undefined) return next
    return new Response(JSON.stringify({ error: { message: 'no more' } }), { status: 500 })
  }

  const config = makeConfig()
  const state = makeState()
  const proxy = await startPoolProxy({
    ctx,
    getConfig: () => config,
    state,
    usage,
    logger: { info: () => {}, warn: () => {} },
    token: 'test-token',
    preferredPort: 18931,
    upstreamFetch,
  })

  try {
    const base = `http://127.0.0.1:${proxy.port}/v1`

    // 1) 无 token
    const unauth = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [] }),
    })
    assert.equal(unauth.status, 401)

    // 2) 模型不在目录
    const badModel = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ model: 'nope', messages: [] }),
    })
    assert.equal(badModel.status, 400)
    const badJson = await badModel.json()
    assert.match(badJson.error.message, /不在账号池目录/)

    // 3) 正常透传
    const ok = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(ok.status, 200)
    const text = await ok.text()
    assert.match(text, /上游答复/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://upstream.test/v1/chat/completions')
    assert.equal(calls[0].headers.authorization, 'Bearer sk-key-1')
    assert.match(calls[0].headers['x-opencode-session'], /^pool-proxy-m1/)

    // 4) 429 → 换号 + 冷却
    const rateLimited = async () => new Response(JSON.stringify({ error: { message: 'rate' } }), { status: 429 })
    const savedFetch = upstreamFetch
    const firstAccount = calls[0].headers.authorization
    let switched = 0
    const failing = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: init.body })
      switched += 1
      if (switched === 1) return rateLimited()
      return sseResponse('换号成功')
    }
    // 用新代理实例避免状态串味（同一端口会重试到下一个）
    const proxy2 = await startPoolProxy({
      ctx,
      getConfig: () => config,
      state,
      usage,
      logger: { info: () => {}, warn: () => {} },
      token: 'test-token-2',
      preferredPort: proxy.port + 1,
      upstreamFetch: failing,
    })
    try {
      const res2 = await fetch(`http://127.0.0.1:${proxy2.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token-2' },
        body: JSON.stringify({ model: 'm1', messages: [] }),
      })
      const body2 = await res2.text()
      assert.equal(res2.status, 200)
      assert.match(body2, /换号成功/)
      assert.equal(switched, 2, '429 后应当换第二个号重发')
      assert.notEqual(calls.at(-1).headers.authorization, calls.at(-2).headers.authorization, '第二个号必须是不同的账号')
      assert.ok(state.cooldowns.size >= 1, '被限流的号应当进冷却')
      assert.notEqual(savedFetch, failing)
      assert.ok(firstAccount.startsWith('Bearer '))
    } finally {
      await proxy2.close()
    }
  } finally {
    await proxy.close()
  }
})

test('translate.json：空配置 → 自动写入并选中代理端点', async () => {
  const { mkdtempSync, readFileSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { syncTranslateEndpoint } = await import('../lib/local-proxy.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-translate-'))
  const storePath = join(dir, 'translate.json')

  const result = await syncTranslateEndpoint({ storePath, port: 8899, token: 'tok', model: 'm1' })
  assert.equal(result, 'written')
  const saved = JSON.parse(readFileSync(storePath, 'utf8'))
  assert.equal(saved.activeId, 'opencode-go-pool')
  assert.equal(saved.endpoints.length, 1)
  assert.equal(saved.endpoints[0].baseUrl, 'http://127.0.0.1:8899/v1')
  assert.equal(saved.endpoints[0].apiKey, 'tok')
  assert.equal(saved.endpoints[0].model, 'm1')
  // Windows 上 chmod 只影响只读位，mode 断言只在 POSIX 有意义
  if (process.platform !== 'win32') assert.equal(statSync(storePath).mode & 0o777, 0o600, '必须是 0600')

  // 端口变化（重启后换端口）→ 覆盖更新，不新增重复项
  assert.equal(await syncTranslateEndpoint({ storePath, port: 8900, token: 'tok2', model: 'm2' }), 'written')
  const updated = JSON.parse(readFileSync(storePath, 'utf8'))
  assert.equal(updated.endpoints.length, 1)
  assert.equal(updated.endpoints[0].baseUrl, 'http://127.0.0.1:8900/v1')
})

test('translate.json：用户手填的端点 → 不接管', async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { syncTranslateEndpoint } = await import('../lib/local-proxy.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-translate-'))
  const storePath = join(dir, 'translate.json')
  const manual = {
    activeId: 'mine',
    endpoints: [{ id: 'mine', label: '我的端点', baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'x' }],
  }
  writeFileSync(storePath, JSON.stringify(manual), 'utf8')

  assert.equal(await syncTranslateEndpoint({ storePath, port: 8899, token: 'tok', model: 'm1' }), 'kept-user')
  assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')), manual, '用户配置必须原样保留')
})
