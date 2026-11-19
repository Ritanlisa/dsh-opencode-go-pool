# dsh-opencode-go-pool

[![npm version](https://img.shields.io/npm/v/dsh-opencode-go-pool.svg)](https://www.npmjs.com/package/dsh-opencode-go-pool)
[![license](https://img.shields.io/npm/l/dsh-opencode-go-pool.svg)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-opencode-go-pool.svg)](package.json)

把 N 个 OpenCode Go 订阅合并成 **一个** DSH 模型提供商，自动选号、会话粘滞、额度耗尽自动换号，并在输入框工具行显示各账号的用量曲线。

```
~/.dsh/
├── plugin-src/dsh-opencode-go-pool/     # 插件源码（本目录）
├── opencode-go-pool/
│   ├── config.json                      # 账号/模型/公式参数（改完 1 秒生效）
│   └── state.json                       # 会话钉号、冷却、用量采样、本地记账
└── profiles/desktop/
    ├── package.json                     # dependencies + dsh.profile.bundles 各加一项
    └── node_modules/dsh-opencode-go-pool -> junction 到 plugin-src
```

## 模型（OpenCode Go 全量 30 个）

模型选择的入口就是 **DSH 自己的模型菜单**：插件通过 `listModels()` 把 `config.json` 里的每个模型
注册成同一个 provider（`opencode-go`）下的可选项，气泡/面板里不再有模型下拉框，只做只读展示。

`config.json` 里现在包含 OpenCode Go 目前提供的全部 30 个模型（取自
`GET https://opencode.ai/zen/go/v1/models` 的权威元数据，含 `limit.context` / `limit.output` /
`capabilities.reasoning` / `modalities.input`）：

| 模型 ID | 名称 | 上下文 | 输出上限 | 图片输入 |
| --- | --- | --- | --- | --- |
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash 1017 | 1,000,000 | 384,000 | ✅ |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1,000,000 | 384,000 | — |
| `glm-5.3` / `glm-5.3-flash` / `glm-5.2` | GLM-5.3 / 5.3-Flash / 5.2 | 1,000,000 | 131,072 | 5.3-Flash ✅ |
| `gpt-6-luna` / `gpt-5.6-luna` | GPT-6 Luna / GPT-5.6 Luna | 1,050,000 | 128,000 | ✅ |
| `claude-haiku-5-5` | Claude Haiku 5.5 | 1,000,000 | 128,000 | ✅ |
| `gemini-4-argon` | Gemini 4 Argon | 1,048,576 | 65,536 | ✅ |
| `kimi-k3.1-pro` / `kimi-k3` / `kimi-k2.7-code` | Kimi K3.1 Pro / K3 / K2.7 Code | 262,144–1,048,576 | 131,072–262,144 | ✅ |
| `grok-4.7` | Grok 4.7 | 500,000 | 500,000 | ✅ |
| `minimax-m3` / `minimax-m3.1-flash` | MiniMax M3 / M3.1 Flash | 1,000,000 | 131,072 / 512,000 | ✅ |
| `qwen3.8-max` / `qwen3.8-flash` / `qwen3.7-plus` | Qwen3.8 Max / 3.8 Flash / 3.7 Plus | 1,000,000 | 65,536–131,072 | ✅ |
| `hy4` / `hy4-preview` / `hy3` | Hy4 / Hy4 preview / Hy3 | 256,000–1,048,576 | 64,000–128,000 | Hy4 ✅ |
| `mimo-v2.6-flash` / `mimo-v2.6-pro` | MiMo-V2.6-Flash / Pro | 1,048,576 | 131,072 | ✅ |
| `longcat-2.0` / `longcat-2.5-free` | LongCat-2.0 / 2.5 Free | 1,000,000 | 131,072 / 262,144 | — |
| `step-5-preview` | Step 5 Preview | 1,000,000 | 65,536 | ✅ |
| `muse-spark-1.3-contributor` / `muse-spark-1.2-contributor` | Muse Spark 1.3 / 1.2 Contributor | 1,048,576 | 131,072 | ✅ |
| `beam-free` / `iceman-contributor-free` | Beam Free / Iceman Contributor Free | 1,048,576 / 262,144 | 131,072 | — |

要点：

- **协议只有一条**：全部模型都走 OpenAI 兼容的 `POST {baseUrl}/chat/completions`。
  官方 docs 的 Endpoints 表里每个模型标的是"原生" API（OpenAI Responses / Anthropic Messages /
  Google v1beta），但同一段说明还写着 *"every text model also works through the other APIs, which
  Console translates"*——Console 会替我们翻译，所以选号层不需要按模型切协议。
- **推理档位统一**为 `{off:none, low:low, high:high, max:max}`，实测 5 个不同家族
  （GLM / Kimi / Qwen / GPT / Claude / Grok / MiniMax / Gemini / Hy / Step）都接受这三档。
- **地区限制**：`muse-spark-*` 与 `beam-free` 在中国大陆会返回
  `403 RegionError: This model is not available in your country`；
  这是上游限制，不是插件问题（模型仍列在菜单里，方便你换地区/工作区隐私设置后直接用）。
  这类错误现在会被识别成**模型级**错误：只报错一次，不换号、不冷却账号。
- **隐私限制**：`iceman-contributor-free` 这类"会训练请求数据"的模型，如果工作区没打开
  *Settings › Privacy › Allow paid endpoints that train on request data*，会返回
  `400 trains on request data`；同样按模型级错误处理（不冷却账号），按提示去 Console 打开即可。
- 新增/删模型只改 `config.json` 的 `models` 数组，1 秒内生效；插件重载配置后会调用
  `registration.replace()` 重新发布路由，宿主随之发出 `llm/adapters-updated`，
  前端的模型目录会自动重拉（**旧版不会发这个事件，所以改完要刷新页面才看得到**）。
- 模型菜单是**页面加载时**从宿主拉的一份目录：如果改完 `config.json` 菜单没变，
  先刷新页面（Ctrl+R）；仍然只有旧模型时，彻底重启 DSH（宿主在启动时按 `registerAdapter` 建路由）。

## 选号规则

```
score = (100 - 月用量%) / max(距套餐重置的天数 - reserveDays, 0)
```

- 越闲、越接近重置的账号分数越高 → 先把快过期的额度烧掉；
- 落在重置前 `reserveDays`（默认 3.5）天以内 → 分母为 0，按正无穷处理（最优先，用光为止）；
- 月用量已满（≥100%）、处于冷却、或者 `status` 标记不可用 → 不参与竞争；
- 没有「立即可用」的号时，兜底**优先在没打满的号里挑**（哪怕它在冷却），发出去由上游给出真实错误；
  只要还有没打满的号，就不会把请求发给已打满的号；
- 全部账号都打满时才按「最早重置」选，不在这里主动拒绝；也不引入任何等待。

**会话策略**：每个会话第一次请求时选号并钉住（保留 KV 缓存/上下文一致），此后同一会一直用它；该号额度耗尽或被限流/鉴权失败时才解钉换号，并把同一会话重新钉到新号。

## 用量从哪来

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <Go 的 API key>
→ {"usage":{"rolling":{...},"weekly":{...},"monthly":{"percent":83,"resetsAt":"2026-11-16T07:56:38Z"}}}
```

用 API key 直读，**不需要 cookie**。插件每 60 秒（`usageRefreshMs`）刷新全部账号，采样写进 `state.json` 供曲线使用。

## 界面

输入框工具行右侧有一枚胶囊（`conversation.input.right`）：显示
**全池月用量**（所有启用账号的平均值，各号套餐上限相同时即整池用掉的百分比）。
鼠标悬停能看到「全池平均 + 每个号明细」；点开是面板：

- 每个账号一行：月用量条、5h/周用量、距重置天数、评分、采样曲线、本地累计美元/次数、prompt cache 命中率；
- 本会话钉住的号有高亮与「本会话」标记；打满/冷却会变灰并注明；
- 「刷新」按钮立刻打一次上游用量；底部写明公式。
- 面板通过 `react-dom` 的 **portal 挂到 `document.body`**（插件槽位的祖先可能带 `transform`/`filter`，
  那样 `position: fixed` 会相对祖先定位、坐标再算也会整体偏出窗口）；渲染后再量一次真实矩形做兜底校正，
  上下方向自适应、`maxHeight = min(屏高 62%, 该侧可用空间)`、宽度夹在窗口内（左右各留 8px），
  窗口 resize 会重新定位。每次打开还会把面板/视口几何写进 `diag.json`，方便核对是否越界。

## 安装

```bash
git clone https://github.com/Ritanlisa/dsh-opencode-go-pool ~/.dsh/plugin-src/dsh-opencode-go-pool
cd ~/.dsh/plugin-src/dsh-opencode-go-pool
node scripts/install-into-desktop.mjs    # 写 link: 依赖 + 建 junction
mkdir -p ~/.dsh/opencode-go-pool
cp config.example.json ~/.dsh/opencode-go-pool/config.json   # 首次装：改账号
```

`scripts/install-into-desktop.mjs` 默认装进 `~/.dsh/profiles/desktop`，可用 `DSH_PROFILE_DIR`
指向别的 profile；脚本从自身位置推导插件源码目录，clone 到哪都能跑。

然后重启 DSH Desktop（客户端 bundle 在启动时合成，热重载只覆盖宿主半边）。

**密钥不放仓库**：`config.json` 里只写 `apiKeyEnv`（环境变量名或 `~/.dsh/.credentials.yaml` 的键），
真实 key 由宿主凭据服务 / 环境变量 / 凭据文件解析。`config.json`、`state.json`、`*.ndjson`
已在 `.gitignore` 里。

### 从 npm 装（可选）

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-opencode-go-pool        # 或 npm i dsh-opencode-go-pool
```

然后把 `"dsh-opencode-go-pool"` 加进该 profile `package.json` 的 `dsh.profile.bundles` 数组
（和 `scripts/install-into-desktop.mjs` 做的事一样，只是依赖写成版本号而不是 `link:`），重启 DSH。

## 加账号

1. 在 `~/.dsh/.credentials.yaml` 的 `refs:` 下加一行 `OPENCODE_GO_4_API_KEY: oc_sk_xxx`；
2. 在 `~/.dsh/opencode-go-pool/config.json` 的 `accounts` 里加 `{"id":"go-4","label":"Go 4","apiKeyEnv":"OPENCODE_GO_4_API_KEY"}`；
3. 保存即可（配置有 watcher，1 秒内重载；账号数量不限）。

也可以完全不写 `accounts`：启动时自动扫描 `refs:` 里所有 `OPENCODE_GO*` 键生成账号。

### 在面板里直接增删（推荐）

点胶囊打开面板：

- 顶部四宫格：**账号数 / 当前可用（未停用、未打满、未冷却）/ 全池月用量 / 本会话账号**。
- 每个账号一张卡：色点 + 名称 + 徽章（本会话 / 冷却中 / 月额度已满 / 已停用），右侧是本月用量百分比；
  下面三条迷你进度条分别是 **5 小时 / 本周 / 本月** 窗口，再下面是距重置、评分、缓存命中率、本地累计花费与请求数，最右是采样曲线。
- 卡片底部四个动作：
  - **切到该号**：把本会话手动钉到这个账号（冷却中会顺带解除冷却）；已在用则显示「已在本会话」。
  - **解除冷却**：清掉冷却，让它立刻重新参与选号（账号旁出现「冷却中」时才显示）。
  - **停用 / 启用**：保留历史采样，只是不参与选号。
  - **删除**：点一次变「确认删除？」，再点一次才真删。
- 右上角 **同步模型**：从官方 `GET /zen/go/v1/models` 拉最新目录，**已有模型保序更新、新模型追加到末尾**
  （官方已下架的旧条目保留，不擅自删），结果会显示「新增 N 个 / 更新 N 个」。
- 最后一个启用中的账号不允许删除；失败原因显示在面板顶部。

底层路由：

| 路由 | body | 作用 |
| --- | --- | --- |
| `POST /plugins/dsh-opencode-go-pool/accounts` | `{"action":"add\|toggle\|remove", …}` | 增删改账号（加号时先把 key 写进凭证库） |
| `POST /plugins/dsh-opencode-go-pool/switch` | `{"session":"…","accountId":"go-3"}` | 手动把会话钉到该号 |
| `POST /plugins/dsh-opencode-go-pool/clear-cooldown` | `{"accountId":"go-3"}` | 清掉该号的冷却 |
| `POST /plugins/dsh-opencode-go-pool/models-refresh` | `{}` | 拉官方模型目录并入 `config.json` |

手改 `config.json` 也一样有效（watcher 1 秒重载）。

## 论文伴读联动（翻译端点自动接入）

论文伴读插件（`@ggboy123/dsh-paper-reader`）的翻译走 **babeldoc** 子进程，它只认
「OpenAI 兼容端点 + key + 模型」。为了让它用上账号池，本插件自带一个**本地 OpenAI 兼容代理**：

```
babeldoc ──POST /v1/chat/completions──▶ 127.0.0.1:8791（本插件）
                                        ├─ 选号（沿用评分 + 冷却逻辑）
                                        ├─ 带 x-opencode-session（缓存分桶）
                                        └─▶ https://opencode.ai/zen/go/v1/chat/completions
```

- 启动时挑 `translateProxy.port`（默认 8791，被占用就往后找最多 10 个），只监听 `127.0.0.1`；
- token 随机生成并落 `~/.dsh/opencode-go-pool/proxy-token`（0600），请求必须带
  `Authorization: Bearer <token>`，否则 401；
- 上游 429 / 5xx / 401 → 自动换下一个账号（被打的号冷却 60s），响应**原样透传**（流式/非流式都支持）；
- 同时提供 `GET /v1/models` 方便客户端探测。

启动成功后，插件会把端点写进论文伴读的 `~/.dsh/.dsh-paper-reader/translate.json`：

```json
{
  "activeId": "opencode-go-pool",
  "endpoints": [{
    "id": "opencode-go-pool",
    "label": "OpenCode Go 账号池（自动）",
    "baseUrl": "http://127.0.0.1:8791/v1",
    "apiKey": "<自动生成的本地 token>",
    "model": "deepseek-v4.1-flash"
  }]
}
```

**所以阅读器里点「中」翻译时不用再手填端点。** 规则：

- 文件里没有任何端点 → 写入并选中（开箱即用）；
- 已经有用户手填的端点、且不是我们的 → **原样保留，不接管**；
- 端点是我们写的（换端口后）→ 原地更新，不产生重复项。

配置项（`config.json`，都可省略）：

```json
"translateProxy": { "enabled": true, "port": 8791, "model": "deepseek-v4.1-flash" }
```

`model` 留空则用账号池的第一个模型。想用官方端点而不是池子，就把 `enabled` 设 `false`，
然后照旧手动填。

## 失败分流

| 上游 | 处理 |
| --- | --- |
| 401 / 403 | 该号冷却 30 分钟，换下一个 |
| 402 / 429 | 先拉一次用量确认：月额度满 → 冷却到 `resetsAt`；否则冷却 3 分钟 |
| 5xx | 冷却 3 分钟，换下一个 |
| 400 且响应含 quota/limit/额度 | 按额度不足处理 |
| **连接失败（`fetch failed`）** | **网络层问题，与账号无关**：该号只冷却 15 秒，并在 30s 预算内最多重试 4 轮 |

换号只在**还没吐字**时发生；流开始后失败直接上抛，避免重复输出。

**限流不是死路**：一轮里所有账号都失败、且错误属于「限流 / 上游 5xx / 连接抖动」时，插件会退避
（`config.json` 的 `retryBackoffMs`，默认 2500ms）后清空排除集**再来一轮**，总预算 15s。
原来的写法是「三个号各 429 一次 → 直接抛错」，用户只看到一句「本轮出错了」；
现在一次 429 会先重试，真失败才报错。

所有失败都会落到 `~/.dsh/opencode-go-pool/errors.ndjson`（最近 100 条，含 HTTP 状态与网关原文；
连接类失败还会带 `cause`，把 undici 藏在 `error.cause` 里的真实原因展开），
排查时先看这个文件，不用再猜：

```json
{"at":"…","kind":"http","sessionId":"session-…","accountId":"go-3","status":429,"code":"RATE_LIMIT","snippet":"{\"type\":\"error\",…}","message":"账号 Go 3 被限流（HTTP 429）…"}
{"at":"…","kind":"transport","sessionId":"session-…","accountId":"go-2","cause":"TypeError fetch failed <- Error code=ECONNRESET syscall=read","message":"账号 Go 2 连接失败（网络层，与额度无关）：…"}
{"at":"…","kind":"give-up","sessionId":"session-…","code":"RATE_LIMIT","message":"账号 Go 1 被限流（HTTP 429）…"}
```

## 请求身份（UA / 会话头 / prompt cache）

OpenCode Go 对客户端有三条要求（[docs/console/go → Where can I use it](https://opencode.ai/v2/docs/console/go/#where-can-i-use-it)）：
发典型 coding agent 流量、用自己的 user agent 自报身份、每个会话在 `x-opencode-session` 里带稳定 id
（供其路由与 prompt cache 分桶）。三条都落在 `lib/identity.mjs` 一个地方：

| 要求 | 本插件发的值 |
| --- | --- |
| 自己的 UA | `opencode-go-pool/<版本> (+https://github.com/deepseek-ai/deepseek-harness)`，版本取自 `package.json`，不手抄 |
| 会话路由 / 缓存分桶 | `x-opencode-session: <DSH 会话 id>`（没有 sessionId 时用落盘的稳定兜底 id，跨重启不变） |
| 让 OpenCode 认出 DSH | `x-deepseek-harness-session-id: <同一个 id>`（DSH 官方适配器发的就是这个原生头） |
| coding agent 流量形态 | `accept: text/event-stream`、`stream: true`、`stream_options.include_usage`、工具与推理档位原样透传 |

两个会话头**同值一起发**：缺 `x-opencode-session` → 网关直接 400 `MissingSessionID`；
只发原生头 → 请求能过，但基本不进缓存桶（实测单会话连打 10 次，命中 0 次；两个头一起发时同样的打法命中 9/10）。
实测（2026-11-06，同一段 3459 token 前缀连打两次同一个会话）：

```
status=200  x-opencode-session + x-deepseek-harness-session-id
第一次  cached=0     prompt=3459  allowance=0.00062838
第二次  cached=3456  prompt=3459  allowance=0.00001874   ← 命中 99.9%，账单降到 1/33
```

换一个会话 id 命中即归零，说明缓存确实按会话分桶——所以 DSH 传入的 sessionId 必须逐轮稳定地发出去。
用量查询（`GET /usage`）复用同一个 UA，但不带会话头（那不是推理流量）。

面板里每个账号行的「缓存 xx%」就是本插件自己请求的命中率
（`cacheRead / (未命中输入 + cacheRead)`，数据来自响应 `usage.prompt_tokens_details.cached_tokens`）。

## 测试

```bash
node --test test/unit.test.mjs   # 公式/选号/序列化/SSE 翻译/出站身份头
node test/apply.mjs              # 宿主装配 + 路由 + 客户端 bundle 契约
node test/e2e.mjs                # 真实请求跑通整条链路（会花一点额度）
```

## 图片支持（多模态）

DeepSeek V4.1 Flash 原生收图，插件按 OpenAI 兼容的 `image_url` 发 data URL：

1. `ImageBlock.attachment` 是 `ImageAttachmentRef`（attachmentId/mediaType/bytes/宽高，无字节）；
2. 适配器调官方附件服务 `ctx.attachments.readImageRequest(ref, target, signal)` 取「请求版本」
   （按长边 ≤2048、编码 ≤2MB 派生，带磁盘缓存），再 base64 成 `data:<mediaType>;base64,…`；
3. 同一张图按 `attachmentId+目标尺寸` 缓存 24 条，多轮带历史图不会重复编码；
4. 取不到字节时降级成一行 `[图片未随请求发送：名称]`，请求照发，不会整轮失败。

实测（2026-11-04）：16×16 红方块 → 模型回答「红色」，`allowance ≈ 0.0000186`（同规模纯文字约 0.0000089，图片确实更贵）。
`config.json` 里模型的 `input` 可写 `["text"]` 关掉图片、或 `["text","image"]` 打开。

### 请求体体积（网关硬上限 64 MiB）

历史图片每轮都会重新带进请求体，一张 2 MiB 的图 base64 后约 2.7 MiB，几十张截图会顶到网关
`413 Request bodies must be at most 64 MiB`。DSH 的压缩按 token 算，图片几乎不计 token，
所以图片堆积**不会**触发压缩。插件现在自己做三层保护：

1. **图片总预算 20 MiB**：从最新往最旧分配，超出的旧图降级成
   `[图片已省略：为控制请求体大小，历史图片不再随请求发送]`（文本与最近的图保留）；
2. **整包 60 MiB 上限**：组装完实测字节数，超了就去掉**全部**图片重建一次；
3. **上游仍返回 413**：自动去图重发一次；重发还超才报
   「请求体超过网关 64 MiB 上限…请先压缩会话」，并且**不冷却账号**（跟账号无关）。

所以正常情况下不会再看到 413；真看到时说明纯文本历史就超过 60 MiB，压缩会话即可。

## 已知限制

- `provider.id` 改名需要重启（路由按启动时的 id 注册）。
- 上游没有公开「套餐总额度」数值，面板显示的是百分比（来自 `/usage`）与实际累计美元（来自响应里的 `usage.opencode.allowance`）。

## 测试

```bash
node --test test/unit.test.mjs   # 单测：评分、选号、序列化、SSE、身份头、413 体积保护
node test/apply.mjs              # 装配冒烟：假 ctx 走一遍 apply()，校验路由与客户端 bundle 契约
node test/e2e.mjs                # 真机冒烟（需要真实 key；可跳过）
```

## License

[MIT](LICENSE) © 2026 Ritanlisa
