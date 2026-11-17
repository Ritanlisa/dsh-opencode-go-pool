/**
 * 选号层：纯函数，方便单测。
 *
 * 公式（用户口径）：
 *     score = (100 - 月用量%) / max(距套餐重置的天数 - reserveDays, 0)
 * - 越闲、越接近重置 → 分数越高（先烧快过期的额度）；
 * - 落在「重置前 reserveDays 天」里的账号分母为 0 → 按数学极限记为正无穷
 *   （最优先，用光为止）；分子为 0（已用满）时记 0，不参与竞争；
 * - 同分按「用量更低」再按「标签」稳定排序，避免抖动。
 *
 * 会话策略：
 * - 会话第一次请求时选号并钉住；
 * - 之后同一会话一律用钉住的号（上下文/缓存不跨号漂移）；
 * - 钉住的号用满/被限流/鉴权失败 → 解钉、换下一个最高分号并重新钉住。
 */
import { scoreOf } from './score.mjs'

export { scoreOf }

/** 月用量是否已打满（打满即视为不可用）。 */
export function isExhausted(usage) {
  if (usage === undefined) return false
  const percent = usage.monthly?.percent
  if (typeof percent === 'number' && percent >= 100) return true
  const status = usage.monthly?.status
  return typeof status === 'string' && /exhaust|limit|blocked/i.test(status)
}

/**
 * 给账号排序，返回 [{account, score, usage, cooldownUntil, exhausted, reason}]，分数高的在前。
 * @param {object} input - { accounts, usageOf, cooldownOf, config, now, exclude }。
 * @returns {Array<object>} 排序后的候选。
 */
export function rankAccounts({ accounts, usageOf, cooldownOf, config, now = Date.now(), exclude }) {
  const rows =accounts.map((account) => {
    const usage = usageOf(account.id)
    const cooldownUntil = cooldownOf(account.id)
    const exhausted = isExhausted(usage)
    return {
      account,
      usage,
      cooldownUntil,
      exhausted,
      score: scoreOf(usage, config.reserveDays, now),
      excluded: exclude?.has(account.id) === true,
    }
  })
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score === a.score ? 0 : b.score > a.score ? 1 : -1
    const pa = a.usage?.monthly?.percent ?? 0
    const pb = b.usage?.monthly?.percent ?? 0
    if (pa !== pb) return pa - pb
    return a.account.label.localeCompare(b.account.label)
  })
  return rows
}

/**
 * 选一个账号。
 * @param {object} input - { accounts, usageOf, cooldownOf, config, sessionId, state, now, exclude }。
 * @returns {{account: object, reused: boolean, reason: string, ranked: Array<object>}} 选择结果。
 */
export function chooseAccount({ accounts, usageOf, cooldownOf, config, sessionId, state, now = Date.now(), exclude }) {
  const ranked = rankAccounts({ accounts, usageOf, cooldownOf, config, now, exclude })
  const byId = new Map(ranked.map((row) => [row.account.id, row]))

  // 1) 会话钉住的号还健康 → 直接沿用（上下文一致优先）。
  const pinnedId = state?.sessionAccount(sessionId)
  if (typeof pinnedId === 'string') {
    const pinned = byId.get(pinnedId)
    if (pinned !== undefined && !pinned.excluded && pinned.cooldownUntil === undefined && !pinned.exhausted) {
      return { account: pinned.account, reused: true, reason: 'pinned', ranked }
    }
  }

  // 2) 可用集：没被本次请求排除、没在冷却、没打满。
  const eligible = ranked.filter((row) => !row.excluded && row.cooldownUntil === undefined && !row.exhausted)
  if (eligible.length > 0) {
    const best = eligible[0]
    return { account: best.account, reused: false, reason: pinnedId === undefined ? 'first' : 'failover', ranked }
  }

  // 3) 没有「立即可用」的号：兜底时**优先在没打满的号里挑**（哪怕它在冷却），
  //    只有全部账号都打满才退回「最早重置」。发出去的那一个永远不该是已打满的号——
  //    那只会白吃一次 429/额度错误。
  const usable = ranked.filter((row) => !row.excluded && !row.exhausted)
  const fallbackPool = usable.length > 0 ? usable : ranked.filter((row) => !row.excluded)
  const fallback = fallbackPool
    .sort((a, b) => (a.usage?.monthly?.resetsAt ?? Number.POSITIVE_INFINITY) - (b.usage?.monthly?.resetsAt ?? Number.POSITIVE_INFINITY))[0]
  if (fallback !== undefined) {
    return {
      account: fallback.account,
      reused: false,
      reason: usable.length > 0 ? 'fallback-usable-cooling' : 'fallback-all-exhausted',
      ranked,
    }
  }
  return { account: undefined, reused: false, reason: 'none', ranked }
}

/**
 * 分数字符串化（UI 用，Infinity 显示成 ∞）。
 * @param {number} score - 分数。
 * @returns {string} 展示值。
 */
export function formatScore(score) {
  if (!Number.isFinite(score)) return score > 0 ? '∞' : '0'
  return score >= 100 ? score.toFixed(0) : score.toFixed(2)
}
