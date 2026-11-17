/**
 * 失败留档：把上游失败（HTTP 状态 + 网关原文片段 + 归一化错误）落到
 * `~/.dsh/opencode-go-pool/errors.ndjson`（最多保留 100 条）。
 *
 * 为什么需要它：DSH 的会话 UI 只显示一句「本轮出错了」，插件抛出的
 * 「账号 X 被限流（HTTP 429）…」在气泡里看不到；没有这份日志，
 * 排查只能靠猜。写入失败不影响推理主链路。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { POOL_DIR } from './config.mjs'

/**
 * 失败日志路径（每次现算，方便测试用 OPENCODE_GO_POOL_DIR 指到临时目录）。
 * @returns {string} errors.ndjson 的绝对路径。
 */
function errorLogPath() {
  const dir = process.env.OPENCODE_GO_POOL_DIR || POOL_DIR
  return join(dir, 'errors.ndjson')
}

/** 最多保留多少条（文件不会无限长）。 */
const MAX_ENTRIES = 100

/**
 * 追加一条失败记录。
 * @param {object} event - { kind, sessionId, accountId, status, snippet, message, code }。
 */
export function recordError(event) {
  try {
    const entry = { at: new Date().toISOString(), ...event }
    const file = errorLogPath()
    let list = []
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8')
      list = text.split('\n').filter((line) => line.trim() !== '').map((line) => {
        try { return JSON.parse(line) } catch { return undefined }
      }).filter((item) => item !== undefined)
    }
    list.push(entry)
    const kept = list.slice(-MAX_ENTRIES)
    writeFileSync(file, `${kept.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
  } catch {
    // 留档失败不能拖垮请求
  }
}

/**
 * 读最近 N 条失败记录（面板/排查用）。
 * @param {number} limit - 条数上限。
 * @returns {Array<object>} 记录（新的在后）。
 */
export function recentErrors(limit = 20) {
  try {
    const file = errorLogPath()
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try { return JSON.parse(line) } catch { return undefined }
      })
      .filter((item) => item !== undefined)
      .slice(-limit)
  } catch {
    return []
  }
}
