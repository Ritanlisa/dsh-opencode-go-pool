/**
 * 配置层：~/.dsh/opencode-go-pool/config.json 的唯一读取口。
 *
 * - 账号是数组，长度不限（1 个也能跑），增删改在 1 秒内热生效（watchFile）；
 * - 文件缺失时按 ~/.dsh/.credentials.yaml 里 `OPENCODE_GO*` 的凭据引用自动生成，
 *   所以「有几个 key 就有几个号」，不写死数量；
 * - 只做形状校验与缺省合并，不在这里访问网络、不读凭据值（值在 api-keys.mjs 解析）。
 */
import { existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 主目录（桌面端与 CLI 共用 ~/.dsh；DSH_HOME 可覆盖）。 */
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
/** 本插件自己的状态/配置目录。 */
export const POOL_DIR = process.env.OPENCODE_GO_POOL_DIR || join(DSH_HOME, 'opencode-go-pool')
/** 配置文件路径。 */
export const CONFIG_PATH = join(POOL_DIR, 'config.json')
/** 运行状态（会话钉号、冷却、采样曲线）路径。 */
export const STATE_PATH = join(POOL_DIR, 'state.json')
/** 凭据引用表（DSH 的 apiKeyEnv 就指向这里的键）。 */
export const CREDENTIALS_PATH = join(DSH_HOME, '.credentials.yaml')

/** DeepSeek V4.1 Flash 在 Go 档的默认模型元数据（与 /zen/go/v1/models 一致）。 */
export const DEFAULT_MODEL = {
  id: 'deepseek-v4.1-flash',
  name: 'DeepSeek V4.1 Flash',
  contextWindow: 1000000,
  maxTokens: 384000,
  /** 输入模态：DeepSeek V4.1 Flash 原生支持文本 + 图片。 */
  input: ['text', 'image'],
  defaultEffort: 'high',
  efforts: { off: 'none', low: 'low', high: 'high', max: 'max' },
}

/** 形状校验失败时抛这个（apply 里记 warn 并继续用缺省值）。 */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** 字符串非空判定。 */
function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** 有限正数判定（含 0 的场合由 min 控制）。 */
function num(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback
}

/**
 * 解析 ~/.dsh/.credentials.yaml 的 `refs:` 段（只取值，不落日志）。
 * 该文件是 DSH 自己的凭据引用表，形状固定：顶层 `refs:` + 两空格缩进的 `KEY: value`。
 * @param {string} path - 凭据文件路径。
 * @returns {Record<string, string>} 引用名 → 值；文件缺失时为空对象。
 */
export function readCredentialRefs(path = CREDENTIALS_PATH) {
  const out = {}
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  let inRefs = false
  for (const line of raw.split(/\r?\n/)) {
    if (!inRefs) {
      if (/^refs:\s*$/.test(line)) inRefs = true
      continue
    }
    if (/^\S/.test(line)) break // 顶层下一个键，refs 段结束
    const m = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value !== '') out[m[1]] = value
  }
  return out
}

/**
 * 从凭据引用生成账号数组：所有以 OPENCODE_GO 开头的引用各算一个号。
 * 引用名保持为 apiKeyEnv，标签给一个人话序号；用户可随时改 config.json。
 * @param {Record<string, string>} refs - 凭据引用表。
 * @returns {Array<object>} 归一化后的账号。
 */
export function accountsFromCredentialRefs(refs) {
  const names = Object.keys(refs)
    .filter((name) => /^OPENCODE_GO(_|$)/.test(name))
    .sort((a, b) => {
      const rank = (n) => (n === 'OPENCODE_GO_API_KEY' ? 0 : 1)
      return rank(a) - rank(b) || a.localeCompare(b)
    })
  return names.map((name, index) => ({
    id: `go-${index + 1}`,
    label: `Go ${index + 1}`,
    apiKeyEnv: name,
    enabled: true,
  }))
}

/**
 * 合并缺省值并校验，返回插件内部使用的规范配置。
 * @param {unknown} raw - 用户 JSON。
 * @param {{ refs?: Record<string, string> }} context - 自动补账号所需的凭据引用。
 * @returns {object} 规范配置。
 */
export function normalizeConfig(raw, context = {}) {
  if (raw !== undefined && raw !== null && typeof raw !== 'object') throw new ConfigError('config 根必须是对象')
  const src = raw ?? {}
  const providerSrc = typeof src.provider === 'object' && src.provider !== null ? src.provider : {}
  const provider = {
    id: text(providerSrc.id, 'opencode-go'),
    name: text(providerSrc.name, 'OpenCode Go'),
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider.id)) {
    throw new ConfigError(`provider.id "${provider.id}" 只能用小写字母/数字/连字符`)
  }

  const modelSrc = Array.isArray(src.models) && src.models.length > 0 ? src.models : [DEFAULT_MODEL]
  const models = modelSrc.map((model) => {
    if (typeof model !== 'object' || model === null) throw new ConfigError('models[] 每项必须是对象')
    const id = text(model.id, '')
    if (id === '') throw new ConfigError('models[].id 不能为空')
    const effortsSrc = typeof model.efforts === 'object' && model.efforts !== null ? model.efforts : DEFAULT_MODEL.efforts
    const efforts = {}
    for (const [key, value] of Object.entries(effortsSrc)) {
      if (typeof value === 'string' && value.trim() !== '') efforts[key] = value.trim()
    }
    // 输入模态：只认 text / image；省略时默认两者都开（模型本身支持多模态）。
    const inputSrc = Array.isArray(model.input) ? model.input : DEFAULT_MODEL.input
    const input = [...new Set(inputSrc.filter((item) => item === 'text' || item === 'image'))]
    return {
      id,
      name: text(model.name, id),
      contextWindow: num(model.contextWindow, DEFAULT_MODEL.contextWindow, { min: 1024 }),
      maxTokens: num(model.maxTokens, DEFAULT_MODEL.maxTokens, { min: 256 }),
      input: input.length > 0 ? input : ['text'],
      defaultEffort: text(model.defaultEffort, DEFAULT_MODEL.defaultEffort),
      efforts: Object.keys(efforts).length > 0 ? efforts : { ...DEFAULT_MODEL.efforts },
    }
  })

  const accountSrc = Array.isArray(src.accounts) ? src.accounts : []
  const accounts = accountSrc.map((account, index) => {
    if (typeof account !== 'object' || account === null) throw new ConfigError('accounts[] 每项必须是对象')
    const id = text(account.id, `go-${index + 1}`)
    const apiKeyEnv = text(account.apiKeyEnv, undefined)
    const apiKey = text(account.apiKey, undefined)
    if (apiKeyEnv === undefined && apiKey === undefined) {
      throw new ConfigError(`账号 ${id} 必须给 apiKeyEnv（推荐）或 apiKey`)
    }
    return {
      id,
      label: text(account.label, id),
      apiKeyEnv,
      apiKey,
      enabled: account.enabled !== false,
    }
  })
  const ids = new Set()
  for (const account of accounts) {
    if (ids.has(account.id)) throw new ConfigError(`账号 id 重复：${account.id}`)
    ids.add(account.id)
  }

  const finalAccounts = accounts.length > 0
    ? accounts
    : accountsFromCredentialRefs(context.refs ?? readCredentialRefs())
  if (finalAccounts.length === 0) {
    throw new ConfigError('没有任何账号：请在 config.json 的 accounts 里配置，或在 .credentials.yaml 里加 OPENCODE_GO* 凭据引用')
  }

  return {
    provider,
    baseUrl: text(src.baseUrl, 'https://opencode.ai/zen/go/v1').replace(/\/+$/, ''),
    reserveDays: num(src.reserveDays, 3.5, { min: 0, max: 365 }),
    usageRefreshMs: num(src.usageRefreshMs, 60000, { min: 10000, max: 3600000 }),
    usageTimeoutMs: num(src.usageTimeoutMs, 8000, { min: 1000, max: 60000 }),
    requestTimeoutMs: num(src.requestTimeoutMs, 180000, { min: 10000, max: 1800000 }),
    maxFailoverAttempts: num(src.maxFailoverAttempts, 3, { min: 1, max: 8 }),
    /** 一轮账号全失败后的退避（限流/5xx/连接类才重试；0 = 不等待）。 */
    retryBackoffMs: num(src.retryBackoffMs, 2500, { min: 0, max: 30000 }),
    /** 一次请求里图片 data URL 的总预算（MiB）；超了从最旧的图片开始省略。网关硬上限 64 MiB。 */
    imageBudgetMiB: num(src.imageBudgetMiB, 20, { min: 1, max: 48 }),
    models,
    /** 全部账号（含 enabled:false）：UI 要能展示并重新启用它们。 */
    allAccounts: finalAccounts,
    /** 参与选号/查询的账号（enabled:false 被排除）。 */
    accounts: finalAccounts.filter((account) => account.enabled !== false),
  }
}

/** 把规范配置写成一份带注释说明的初始文件（只在文件不存在时调用）。 */
function writeBootstrapConfig(refs) {
  mkdirSync(POOL_DIR, { recursive: true })
  const accounts = accountsFromCredentialRefs(refs)
  const bootstrap = {
    $schema: 'dsh-opencode-go-pool/config@1',
    $help: [
      'accounts 是数组，长度不限：加号就加一项（apiKeyEnv 指向 ~/.dsh/.credentials.yaml 的 refs 键，或直接写 apiKey）。',
      'reserveDays 是评分公式里预留的天数：score = (100 - monthly.percent) / max(距 monthly.resetsAt 的天数 - reserveDays, 0)。',
      'models 决定模型选择框里出现哪些模型；efforts 是 reasoning 档位到线上 reasoning_effort 的映射。',
      '改完保存即可，1 秒内生效（provider.id 例外，改名需重启）。',
    ],
    provider: { id: 'opencode-go', name: 'OpenCode Go' },
    baseUrl: 'https://opencode.ai/zen/go/v1',
    reserveDays: 3.5,
    usageRefreshMs: 60000,
    models: [DEFAULT_MODEL],
    accounts: accounts.length > 0
      ? accounts
      : [{ id: 'go-1', label: 'Go 1', apiKeyEnv: 'OPENCODE_GO_API_KEY' }],
  }
  writeFileSync(CONFIG_PATH, `${JSON.stringify(bootstrap, null, 2)}\n`, 'utf8')
}

/**
 * 读取并规范化配置；文件不存在时先按凭据自动生成一份。
 * @returns {object} 规范配置。
 */
export function loadConfig() {
  const refs = readCredentialRefs()
  if (!existsSync(CONFIG_PATH)) writeBootstrapConfig(refs)
  let raw
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (error) {
    throw new ConfigError(`读不懂 ${CONFIG_PATH}：${error instanceof Error ? error.message : String(error)}`)
  }
  return normalizeConfig(raw, { refs })
}

/**
 * 监听配置文件变化；回调收到新配置或错误。
 * @param {(config: object|undefined, error?: Error) => void} onChange - 变更回调。
 * @returns {() => void} 停止监听。
 */
export function watchConfig(onChange) {
  const listener = (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs) return
    try {
      onChange(loadConfig())
    } catch (error) {
      onChange(undefined, error instanceof Error ? error : new Error(String(error)))
    }
  }
  watchFile(CONFIG_PATH, { interval: 1000 }, listener)
  return () => unwatchFile(CONFIG_PATH, listener)
}
