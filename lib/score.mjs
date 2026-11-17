/**
 * 评分公式（纯函数）：score = (100 - 月用量%) / max(距重置天数 - reserveDays, 0)
 *
 * 边界语义（与用户口径一致，并写进 README 与 UI 提示）：
 * - 月用量已满（percent >= 100）→ 0 分（不参与竞争）；
 * - 落在重置前 reserveDays 天以内（分母 0）→ 正无穷（用光为止，最优先）；
 * - 没有用量数据 → NaN，排序时排在有分数者之后；
 * - resetsAt 缺失 → 视为 30 天后（保守，不因缺数据把号推到最前面）。
 */

/** 缺失 resetsAt 时的保守假设：30 天。 */
const ASSUMED_CYCLE_DAYS = 30

/**
 * 一个账号的优先级分数。
 * @param {object|undefined} usage - 归一化用量 {monthly:{percent,resetsAt}}。
 * @param {number} reserveDays - 预留天数（分母里的 3.5）。
 * @param {number} [now] - 当前时间戳（测试注入）。
 * @returns {number} 分数；无数据为 NaN。
 */
export function scoreOf(usage, reserveDays, now = Date.now()) {
  if (usage === undefined || usage === null) return Number.NaN
  const percent = usage.monthly?.percent
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return Number.NaN
  const usable = (100 - Math.min(Math.max(percent, 0), 100)) / 100
  if (usable <= 0) return 0
  const resetsAt = usage.monthly?.resetsAt
  const daysLeft = (typeof resetsAt === 'number' && Number.isFinite(resetsAt))
    ? (resetsAt - now) / 86400000
    : ASSUMED_CYCLE_DAYS
  const denominator = Math.max(daysLeft - reserveDays, 0)
  if (denominator === 0) return Number.POSITIVE_INFINITY
  return usable / denominator
}
