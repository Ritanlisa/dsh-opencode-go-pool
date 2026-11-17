/**
 * 出站身份层：所有发往 OpenCode Go 的请求共用同一份客户端标识与会话头。
 *
 * 背景：OpenCode Go 对客户端有明确要求（opencode.ai/docs/console/go → Where can I use it）：
 *   1. 发典型 coding agent 流量；
 *   2. 用**自己的** user agent 自报身份（`my-coding-agent/1.0` 这种 product/version），
 *      不要落到通用 SDK / HTTP 库名（node、undici、python-requests 之类）；
 *   3. 每个会话在 `x-opencode-session` 里带一个稳定 id，供其路由与 prompt cache 分桶。
 *
 * 文档还专门点名 DeepSeek Harness：「它认得 DSH 的原生会话头，剩下的是让所有适配器都发」。
 * DSH 官方适配器（dsh-llm-deepseek）发的原生头是 `x-deepseek-harness-session-id`；
 * 本插件早先只发 `x-opencode-session`，等于没走上那条兼容路径。
 *
 * 实测（2026-11-06，同一段 5439 token 前缀打 /zen/go/v1/chat/completions）：
 *   - 同一 x-opencode-session 连打 → cached_tokens 5376（98.8%），allowance 从 4.9e-4 降到 1.8e-5；
 *   - 换一个 session id → cached_tokens 0（说明缓存确实以会话 id 分桶）；
 *   - 只发原生头不发 x-opencode-session → 400 MissingSessionID；
 *   - 两个头同值一起发 → 200，且命中稳定。
 * 所以：两个头都发、同值、逐会话稳定；UA 用本插件自己的 product token。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

/** UA 里的 product token（本插件自己的名字，按 RFC 9110 用小写连字符形式）。 */
export const CLIENT_PRODUCT = 'opencode-go-pool'
/** UA 里的版本号：直接取本包 package.json，不手抄，杜绝漂移。 */
export const CLIENT_VERSION = typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
/** UA 注释里的仓库地址（自报身份用，公开信息，无隐私）。 */
export const CLIENT_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/**
 * 唯一的 User-Agent：`product/version (+url)`。
 * 不含 node / undici / fetch 之类通用库名，也不会随请求变化。
 */
export const USER_AGENT = `${CLIENT_PRODUCT}/${CLIENT_VERSION} (+${CLIENT_URL})`

/** OpenCode 自己的会话头：网关按它做路由亲和与 prompt cache 分桶（缺了直接 400）。 */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'
/** DSH 原生会话头：OpenCode 用它识别 DSH 客户端并走兼容路径（官方适配器发的是它）。 */
export const NATIVE_SESSION_HEADER = 'x-deepseek-harness-session-id'

/**
 * 把候选会话 id 收敛成可上线的头值。
 * @param {unknown} value - 候选值。
 * @returns {string|undefined} 合法值；空/非字符串返回 undefined。
 */
function headerValue(value) {
  if (typeof value !== 'string' || value === '') return undefined
  // 头值里出现 CR/LF 会被 HTTP 层拒绝或截断，这种值直接判非法（上层会退回兜底 id）。
  if (/[\r\n]/.test(value)) return undefined
  return value
}

/**
 * 构造两个会话头（同值）。
 * @param {string|undefined} sessionId - 本会话的稳定 id（DSH 的 GenerateOptions.sessionId）。
 * @param {string|undefined} fallbackSession - 没有 sessionId 时用的稳定兜底 id。
 * @returns {Record<string, string>} 头对象。
 * @throws {Error} 两个候选都不可用时抛错（宁可显式失败，也不发一个会被网关拒的请求）。
 */
export function sessionHeaders(sessionId, fallbackSession) {
  const value = headerValue(sessionId) ?? headerValue(fallbackSession)
  if (value === undefined) throw new Error('会话头需要一个非空会话 id（sessionId 与兜底 id 都不可用）')
  return {
    [OPENCODE_SESSION_HEADER]: value,
    [NATIVE_SESSION_HEADER]: value,
  }
}

/**
 * 推理请求（chat.completions）的完整请求头。
 * @param {{ apiKey: string, sessionId?: string, fallbackSession?: string }} input - 账号 key 与会话 id。
 * @returns {Record<string, string>} 头对象。
 */
export function inferenceRequestHeaders({ apiKey, sessionId, fallbackSession }) {
  return {
    'content-type': 'application/json',
    // 与 DSH 官方适配器一致：coding agent 一律走 SSE。
    accept: 'text/event-stream',
    authorization: `Bearer ${apiKey}`,
    'user-agent': USER_AGENT,
    ...sessionHeaders(sessionId, fallbackSession),
  }
}

/**
 * 用量查询（GET /usage）的请求头：同一份 UA，不带会话头（这不是推理流量）。
 * @param {string} apiKey - 账号 key。
 * @returns {Record<string, string>} 头对象。
 */
export function usageRequestHeaders(apiKey) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`,
    'user-agent': USER_AGENT,
  }
}
