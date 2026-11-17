/**
 * 端到端冒烟：不启动 DSH，直接把适配器当库跑一次真实请求。
 * 验证链：配置自动生成 → 拉用量 → 选号 → HTTP/SSE → 块翻译 → 本地记账 → 会话钉号。
 * 运行：node test/e2e.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ocgo-e2e-'))
process.env.OPENCODE_GO_POOL_DIR = dir

const { loadConfig } = await import('../lib/config.mjs')
const { StateStore } = await import('../lib/state.mjs')
const { UsageRegistry } = await import('../lib/usage.mjs')
const { OpenCodeGoAdapter } = await import('../lib/adapter.mjs')

const logger = {
  info: (message) => console.log('  info:', message),
  warn: (message) => console.log('  warn:', message),
}
const ctx = { logger }
const config = loadConfig()
console.log(`pool dir: ${dir}`)
console.log(`accounts: ${config.accounts.map((account) => `${account.id}/${account.label}`).join(', ')}`)
const state = new StateStore(join(dir, 'state.json'))
const usage = new UsageRegistry({ ctx, getConfig: () => config, state, logger })
const adapter = new OpenCodeGoAdapter({ ctx, getConfig: () => config, state, usage, logger })

console.log('\n[1] 拉用量（并发）')
await usage.refreshAll({ force: true })
for (const account of config.accounts) {
  const data = usage.usage(account.id)
  console.log(`  ${account.label}: monthly=${data?.monthly?.percent}% reset=${data?.monthly?.resetsAt ? new Date(data.monthly.resetsAt).toISOString() : '?'} rolling=${data?.rolling?.percent}% weekly=${data?.weekly?.percent}%`)
}

console.log('\n[2] 模型元数据')
console.log('  listModels:', JSON.stringify(await adapter.listModels('opencode-go')))
const resolved = await adapter.resolveModel('opencode-go', 'deepseek-v4.1-flash')
console.log('  resolveModel:', JSON.stringify({ context: resolved.context, defaultMaxTokens: resolved.defaultMaxTokens, efforts: resolved.reasoning.efforts.map((effort) => effort.id), defaultEffort: resolved.reasoning.defaultEffort }))

console.log('\n[3] 真实流式请求（会话 e2e-1）')
const chunks = []
const started = Date.now()
for await (const chunk of adapter.stream({
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话说明你是哪个模型。' }] }],
  sessionId: 'e2e-1',
  maxTokens: 200,
  reasoningEffort: 'off',
})) {
  chunks.push(chunk)
}
const text = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block).filter((block) => block.type === 'text').map((block) => block.text).join('')
const finish = chunks.at(-1)
console.log(`  chunks=${chunks.length} elapsed=${Date.now() - started}ms`)
console.log(`  text="${text.trim().slice(0, 120)}"`)
console.log(`  finish=${JSON.stringify(finish)}`)

console.log('\n[4] 会话钉号与本地记账')
console.log('  pinned:', state.sessionAccount('e2e-1'))
for (const account of config.accounts) {
  const local = state.local(account.id)
  if (local.requests > 0) console.log(`  ${account.label}: requests=${local.requests} usd=${local.usd} in=${local.input} out=${local.output}`)
}

console.log('\n[5] 同一会话第二次请求应沿用同一账号')
const firstPin = state.sessionAccount('e2e-1')
for await (const _chunk of adapter.stream({
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '再说一遍，用两个字。' }] }],
  sessionId: 'e2e-1',
  maxTokens: 40,
  reasoningEffort: 'off',
})) { /* 丢弃 */ }
const secondPin = state.sessionAccount('e2e-1')
console.log(`  first=${firstPin} second=${secondPin} reused=${firstPin === secondPin}`)

state.dispose()
usage.stop()
console.log('\nOK')
