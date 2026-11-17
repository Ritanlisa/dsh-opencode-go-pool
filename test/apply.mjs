/**
 * 装配冒烟：用假的 cordis ctx 走一遍 apply()，验证
 *   - 插件导出形状（name/inject/apply）；
 *   - ctx.llm.registerAdapter / ctx.webServer.register / ctx.effect 的调用参数；
 *   - 两个路由 handler 真能产出 JSON；
 *   - 客户端 bundle 的 ModuleLoader 契约与槽注册参数。
 * 不启动 DSH、不发网络请求。
 * 运行：node test/apply.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ocgo-apply-'))
process.env.OPENCODE_GO_POOL_DIR = dir

const plugin = await import('../lib/index.mjs')
assert.equal(plugin.name, 'opencode-go-pool')
assert.deepEqual(plugin.inject, ['llm', 'webServer'])
assert.equal(typeof plugin.apply, 'function')

const registrations = new Map()
const effects = []
const logs = []
const credentialsWrites = []
let adapterArg
let adapterProviders

const ctx = {
  logger: {
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
  },
  credentials: undefined,
  get: (name) => (name === 'credentials'
    ? { set: (ref, value) => { credentialsWrites.push({ ref, value }); return Promise.resolve() } }
    : undefined),
  effect: (factory) => { effects.push(factory()) },
  llm: {
    registerAdapter: (providers, adapter) => {
      adapterProviders = providers
      adapterArg = adapter
      return { dispose: () => registrations.set('disposed-adapter', true), replace: () => {} }
    },
  },
  webServer: {
    register: (options) => {
      registrations.set(options.path, options)
      return () => registrations.delete(options.path)
    },
  },
}

plugin.apply(ctx)
assert.deepEqual(adapterProviders, ['opencode-go'], 'provider id 应为配置里的 opencode-go')
assert.equal(typeof adapterArg.stream, 'function')
assert.ok(registrations.has('/plugins/dsh-opencode-go-pool/state'), '缺 state 路由')
assert.ok(registrations.has('/plugins/dsh-opencode-go-pool/refresh'), '缺 refresh 路由')
assert.ok(registrations.has('/plugins/dsh-opencode-go-pool/diag'), '缺 diag 路由')
assert.equal(registrations.get('/plugins/dsh-opencode-go-pool/state').kind, 'exact')
console.log('host half: apply() OK →', [...registrations.keys()].join(', '))
console.log('logs:', logs.join(' | '))

// 适配器元数据
const models = await adapterArg.listModels('opencode-go')
assert.equal(models[0].id, 'deepseek-v4.1-flash')
assert.equal(adapterArg.providerInfo('opencode-go').name, 'OpenCode Go')
const policy = adapterArg.providerRetryPolicy()
assert.equal(policy.maxRetries, 0)
console.log('adapter: listModels/resolveModel/providerInfo OK →', JSON.stringify(models))

// DSH 0.2.x 契约：运行时直接调 adapter.prepareCall()，缺了就报 "prepareCall is not a function"
const prepared = await adapterArg.prepareCall('opencode-go', 'deepseek-v4.1-flash')
assert.equal(prepared.model.provider, 'opencode-go')
assert.equal(prepared.model.id, 'deepseek-v4.1-flash')
assert.ok(typeof prepared.model.name === 'string' && prepared.model.name.length > 0, 'name 不能为空')
assert.equal(prepared.model.context.contextWindow, 1000000)
assert.ok(Array.isArray(prepared.model.reasoning.efforts) && prepared.model.reasoning.efforts.length > 0)
assert.ok(
  prepared.model.reasoning.efforts.some((effort) => effort.id === prepared.model.reasoning.defaultEffort),
  'defaultEffort 必须在 efforts 里',
)
assert.equal(typeof prepared.stream, 'function')
assert.equal(typeof adapterArg.imageRequestPricing, 'function')
assert.equal(typeof adapterArg.imageRequestTarget, 'function')
assert.equal(adapterArg.imageRequestPricing('opencode-go', 'deepseek-v4.1-flash'), undefined)
assert.deepEqual(
  adapterArg.imageRequestTarget('opencode-go', 'deepseek-v4.1-flash', { width: 10, height: 20, bytes: 30 }),
  { width: 10, height: 20, maxBytes: 30 },
)
console.log('adapter: prepareCall / imageRequest* 契约 OK')

// 路由 handler：伪造 req/res，验证 JSON 形状
async function callRoute(path, search, method = 'GET', body) {
  const handler = registrations.get(path).handler
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers) },
    end(bodyText) { chunks.push(bodyText) },
  }
  const req = {
    url: `${path}${search}`,
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8')
    },
  }
  await handler(req, res)
  return { status: res.statusCode, payload: JSON.parse(chunks.join('')) }
}

const state = await callRoute('/plugins/dsh-opencode-go-pool/state', '?session=demo')
assert.equal(state.status, 200)
assert.equal(state.payload.provider.id, 'opencode-go')
assert.ok(Array.isArray(state.payload.accounts))
assert.equal(state.payload.reserveDays, 3.5)
console.log('route state →', JSON.stringify({ ok: state.payload.ok, accounts: state.payload.accounts.map((a) => a.id), reserveDays: state.payload.reserveDays }))

// 显隐诊断路由：客户端 POST 的判定必须能落盘（排查「别的提供商也显示」）
const diag = await callRoute('/plugins/dsh-opencode-go-pool/diag', '', 'POST', JSON.stringify({ probe: true, source: 'directory' }))
assert.equal(diag.status, 200)
assert.equal(diag.payload.ok, true)
const diagFile = join(dir, 'diag.json')
const diagText = await import('node:fs/promises').then((fs) => fs.readFile(diagFile, 'utf8'))
assert.ok(diagText.includes('"probe": true'), 'diag.json 没写入')
console.log('route diag →', diagFile)

// 账号增删改：面板「＋ / 停用 / 删除」背后的路由
const added = await callRoute('/plugins/dsh-opencode-go-pool/accounts', '', 'POST', JSON.stringify({ action: 'add', label: 'Go 9', apiKey: 'oc_sk_test_only', session: 'demo' }))
assert.equal(added.status, 200, JSON.stringify(added.payload))
const addedAccount = added.payload.accounts.find((account) => account.label === 'Go 9')
assert.ok(addedAccount !== undefined, '新增账号没出现在快照里')
assert.equal(addedAccount.enabled, true)
assert.ok(addedAccount.apiKeyEnv.startsWith('OPENCODE_GO_'), 'apiKeyEnv 未生成')
const stored = credentialsWrites.find((entry) => entry.ref === addedAccount.apiKeyEnv)
assert.ok(stored !== undefined && stored.value === 'oc_sk_test_only', 'key 没写进凭证库')

const toggled = await callRoute('/plugins/dsh-opencode-go-pool/accounts', '', 'POST', JSON.stringify({ action: 'toggle', id: addedAccount.id, enabled: false }))
assert.equal(toggled.status, 200)
assert.equal(toggled.payload.accounts.find((account) => account.id === addedAccount.id).enabled, false, '停用没生效')

const removed = await callRoute('/plugins/dsh-opencode-go-pool/accounts', '', 'POST', JSON.stringify({ action: 'remove', id: addedAccount.id }))
assert.equal(removed.status, 200)
assert.equal(removed.payload.accounts.find((account) => account.id === addedAccount.id), undefined, '删除没生效')

// 全删光必须被拒（至少留一个启用账号）
for (const account of removed.payload.accounts) {
  await callRoute('/plugins/dsh-opencode-go-pool/accounts', '', 'POST', JSON.stringify({ action: 'remove', id: account.id }))
}
const afterLoop = await callRoute('/plugins/dsh-opencode-go-pool/state', '')
assert.equal(afterLoop.payload.accounts.length, 1, '删到只剩一个时应停下')
const empty = await callRoute('/plugins/dsh-opencode-go-pool/accounts', '', 'POST', JSON.stringify({ action: 'remove', id: afterLoop.payload.accounts[0].id }))
assert.equal(empty.status, 400, '删到零个应当被拒绝')
assert.match(empty.payload.error, /至少/, '拒绝理由应说明要保留账号')
console.log('route accounts → add/toggle/remove OK；至少保留一个：', empty.payload.error)

// 客户端 bundle：假的 window.__ModuleLoader__ + 极简 React 垫片
let loaded
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
const reactShim = {
  createElement: () => null,
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const { createRequire } = await import('node:module')
const nodeRequire = createRequire(import.meta.url)
const fakeRequire = (id) => {
  if (id === 'react') return reactShim
  return nodeRequire(id)
}
const bundlePath = join(process.cwd(), 'lib', 'client.js')
const source = await import('node:fs').then((fs) => fs.readFileSync(bundlePath, 'utf8'))
new Function('window', 'require', source)(globalThis.window, fakeRequire)
assert.ok(loaded, '客户端 bundle 没调用 __ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-opencode-go-pool')
const clientExports = loaded.factory(fakeRequire)
assert.equal(typeof clientExports.apply, 'function')
assert.equal(clientExports.name, 'opencode-go-pool')
assert.deepEqual(clientExports.inject, ['slots'])
const slotCalls = []
const injectCalls = []
const fakeDirectory = {
  store: {
    subscribe: () => () => {},
    getSnapshot: () => ({ current: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }),
  },
}
const clientCtx = {
  get: () => undefined,
  inject: (deps, callback) => {
    injectCalls.push(deps.join(','))
    callback({
      modelDirectories: { directoryFor: () => fakeDirectory },
      sessions: { binding: () => undefined },
    })
  },
  slots: {
    inject: (name, factory) => { slotCalls.push({ name, registered: factory() }) },
    register: (options, component) => ({ options, component, dispose: () => {} }),
  },
}
clientExports.apply(clientCtx)
assert.deepEqual(injectCalls, ['modelDirectories', 'sessions'], 'apply 必须抓两条信号源（目录 + 会话投影）')
assert.equal(slotCalls[0].name, 'conversation.input.right')
assert.equal(slotCalls[0].registered.options.id, 'opencode-go-pool')
assert.equal(typeof slotCalls[0].registered.component, 'function')
console.log('client half: ModuleLoader + slot 注册 OK →', JSON.stringify(slotCalls[0].registered.options))

for (const cleanup of effects) if (typeof cleanup === 'function') cleanup()
console.log('\nOK')
