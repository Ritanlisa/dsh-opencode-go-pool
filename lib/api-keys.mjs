/**
 * 凭据解析：把账号的 apiKeyEnv / apiKey 变成一次请求可用的值。
 *
 * 解析顺序（都是「每次操作现取」，所以换 key 不需要重启）：
 *   1. 宿主 ctx.credentials.resolve(ref) —— DSH 的凭据缝（设置页改的值立刻生效）；
 *   2. 进程环境变量 —— 兼容 `OPENCODE_GO_API_KEY=... dsh web`；
 *   3. ~/.dsh/.credentials.yaml 的 refs（桌面端真正落盘的位置）；
 *   4. 账号里写死的 apiKey（不推荐，仅应急）。
 * 任何一层都不进日志：只报来源名与是否存在。
 */
import { readCredentialRefs } from './config.mjs'

/** 引用解析结果。 */
export class MissingApiKeyError extends Error {
  constructor(accountId, ref) {
    super(`账号 ${accountId} 的凭据 ${ref} 解析不到值`)
    this.name = 'MissingApiKeyError'
    this.accountId = accountId
    this.ref = ref
  }
}

/**
 * 为账号解析 API key。
 * @param {object} ctx - 宿主 cordis 上下文（可能没有 credentials 服务）。
 * @param {{ id: string, apiKey?: string, apiKeyEnv?: string }} account - 账号。
 * @returns {Promise<{ key: string, source: string }>} 值与来源。
 */
export async function resolveAccountKey(ctx, account) {
  if (typeof account.apiKey === 'string' && account.apiKey !== '') {
    return { key: account.apiKey, source: 'inline' }
  }
  const ref = account.apiKeyEnv
  if (typeof ref !== 'string' || ref === '') throw new MissingApiKeyError(account.id, '(未配置)')

  // 1. 宿主凭据缝
  try {
    const resolved = await ctx.credentials?.resolve?.(ref)
    if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') {
      return { key: resolved.value, source: `credentials:${resolved.source ?? 'host'}` }
    }
  } catch {
    // 服务缺席或解析实现报错都不致命，继续走后面的层。
  }

  // 2. 环境变量
  const env = process.env[ref]
  if (typeof env === 'string' && env !== '') return { key: env, source: 'env' }

  // 3. DSH 凭据文件
  const fromFile = readCredentialRefs()[ref]
  if (typeof fromFile === 'string' && fromFile !== '') return { key: fromFile, source: 'credentials-file' }

  throw new MissingApiKeyError(account.id, ref)
}
