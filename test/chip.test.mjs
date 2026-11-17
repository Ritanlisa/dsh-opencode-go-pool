import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let def = null
const React = {
  createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c }),
  useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
  useEffect: () => {}, useMemo: (f) => f(), useCallback: (f) => f,
  useRef: (v) => ({ current: v }), Fragment: 'F',
}
const sandbox = {
  window: { __ModuleLoader__: { load: (d) => { def = d } } },
  console, setTimeout, clearTimeout,
  fetch: () => new Promise(() => {}),
  React,
}
sandbox.window.React = React
sandbox.globalThis = sandbox
vm.runInNewContext(src, sandbox, { timeout: 5000 })
const mod = def.factory((n) => (n === 'react' ? React : n === 'react-dom' ? { createPortal: (x) => x } : {}))
const chipUsage = mod.__chipUsage
assert.equal(typeof chipUsage, 'function')

const accounts = [
  { label: 'Go 1', pinned: false, monthly: { percent: 100 } },
  { label: 'Go 3', pinned: true, monthly: { percent: 91 } },
  { label: 'Go 4', pinned: false, monthly: { percent: 12 } },
]
const bound = chipUsage(accounts, 81)
assert.equal(bound.percent, 91, '已绑定会话要显示所绑账号的用量')
assert.equal(bound.label, 'Go 3')
assert.equal(bound.bound, true)

const unbound = chipUsage(accounts.map((a) => ({ ...a, pinned: false })), 81)
assert.equal(unbound.percent, 81, '未绑定会话显示全池平均')
assert.equal(unbound.label, '')
assert.equal(unbound.bound, false)

const noData = chipUsage(accounts.map((a) => ({ ...a, pinned: false })), undefined)
assert.equal(noData.percent, undefined)

const missingMonthly = chipUsage([{ label: 'Go 9', pinned: true }], 40)
assert.equal(missingMonthly.percent, undefined)
assert.equal(missingMonthly.label, 'Go 9')

console.log('chipUsage 断言全部通过 ✅（绑定=91%，未绑定=81%，缺数据=—）')
