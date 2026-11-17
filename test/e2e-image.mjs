/**
 * 图片端到端：DSH image 块 → 附件服务取请求版本 → data URL → 网关 → 模型真的看见图。
 *
 * 附件服务用桩（返回一张 16×16 纯红 PNG），其余全是真链路：
 * 真 config、真选号、真 HTTP、真 SSE 翻译、真记账。
 * 运行：node test/e2e-image.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const dir = mkdtempSync(join(tmpdir(), 'ocgo-image-'))
process.env.OPENCODE_GO_POOL_DIR = dir

/** CRC32（PNG chunk 用）。 */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 组一个 PNG chunk。 */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

/** 生成 size×size 的纯红真彩 PNG。 */
function redPng(size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (1 + size * 3)
    raw[rowStart] = 0
    for (let x = 0; x < size; x += 1) {
      const pixel = rowStart + 1 + x * 3
      raw[pixel] = 220
      raw[pixel + 1] = 20
      raw[pixel + 2] = 20
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const { loadConfig } = await import('../lib/config.mjs')
const { StateStore } = await import('../lib/state.mjs')
const { UsageRegistry } = await import('../lib/usage.mjs')
const { OpenCodeGoAdapter } = await import('../lib/adapter.mjs')

const png = redPng(16)
const logger = {
  info: (message) => console.log('  info:', message),
  warn: (message) => console.log('  warn:', message),
}

/** 附件服务桩：只实现 readImageRequest。 */
const attachments = {
  calls: [],
  async readImageRequest(ref, target) {
    this.calls.push({ ref, target })
    return { data: png, mediaType: 'image/png', bytes: png.length, width: 16, height: 16 }
  },
}

const ctx = {
  logger,
  get: (name) => (name === 'attachments' ? attachments : undefined),
}

const config = loadConfig()
const state = new StateStore(join(dir, 'state.json'))
const usage = new UsageRegistry({ ctx, getConfig: () => config, state, logger })
const adapter = new OpenCodeGoAdapter({ ctx, getConfig: () => config, state, usage, logger })

console.log(`png bytes=${png.length}，pool dir=${dir}`)

const resolved = await adapter.resolveModel('opencode-go', 'deepseek-v4.1-flash')
console.log('[1] 声明的输入模态:', JSON.stringify(resolved.inputModalities))
if (!resolved.inputModalities.includes('image')) throw new Error('inputModalities 里没有 image')

console.log('[2] imageRequestTarget:', JSON.stringify(adapter.imageRequestTarget('opencode-go', 'deepseek-v4.1-flash', { width: 4000, height: 3000, bytes: 9 * 1024 * 1024 })))

const chunks = []
for await (const item of adapter.stream({
  provider: 'opencode-go',
  model: 'deepseek-v4.1-flash',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '这张图是什么颜色？只回答颜色名。' },
      {
        type: 'image',
        attachment: { attachmentId: 'test-red-16', mediaType: 'image/png', bytes: png.length, width: 16, height: 16, name: 'red.png' },
      },
    ],
  }],
  sessionId: 'e2e-image-1',
  maxTokens: 60,
  reasoningEffort: 'off',
})) {
  chunks.push(item)
}

const answer = chunks
  .filter((item) => item.type === 'block-end')
  .map((item) => item.block)
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
  .trim()
const finish = chunks.at(-1)
console.log(`[3] answer="${answer}" finish=${JSON.stringify(finish)}`)
console.log(`[4] 附件服务调用 ${attachments.calls.length} 次，target=${JSON.stringify(attachments.calls[0]?.target)}`)

state.dispose()
usage.stop()

if (!/红/.test(answer)) throw new Error(`模型没识别出红色，回答是："${answer}"`)
console.log('\nOK：图片链路真的通了（模型看见了红色）')
