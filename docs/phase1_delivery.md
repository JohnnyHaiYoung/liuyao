# 第一阶段交付说明：可持久保存的自由聊天网站

版本：2026-10-01。实现依据：[第一阶段研发任务书](phase1_development_spec.md)（下称任务书）、
[产品需求](product_requirements.md)、[技术架构](technical_architecture.md)、[研发计划](development_plan.md)、
[验收清单](acceptance_checklist.md)。本文记录**实际交付内容、实测结果、未完成项、文档冲突处理与关键技术取舍**。

实现位置：`app/`（可运行代码）+ `storage/`（运行时数据）。**未改动产品需求文档**，也未改动 `F:\道教\六爻` 原件。

---

## 1. 交付概览

| 项目 | 实际结果 |
| --- | --- |
| 技术栈 | Node.js **v22.20.0**（LTS）、TypeScript **7.0.2**、Next.js **16.3.8**（App Router，Turbopack 构建）、React **19.3.0** |
| 数据库 | SQLite + better-sqlite3 **13.0.3**（自带预编译原生模块，服务器无需编译工具链）、版本化 SQL 迁移、WAL |
| 模型 | DeepSeek 官方 Chat Completions 流式接口，模型名 `deepseek-flash`（可配置），`stream: true` + `stream_options.include_usage` |
| 浏览器流 | `fetch()` + `POST` 读取 `text/event-stream`，服务端规范化事件 `start / delta / done / error` |
| 登录 | 单拥有者账户，scrypt 强哈希 + 服务端会话 Cookie（HttpOnly、SameSite=Lax） |
| 功能 | 自由聊天、流式显示、停止生成、历史会话列表、继续会话、标题手动重命名、完成/失败/中断状态持久化 |
| 自检结果 | 本机黑盒验收自检（含服务端页面渲染检查）：**通过 29 / 未通过 0**（验收用假模型，覆盖流式与停止）；无密钥与无效密钥场景分别为 21 通过 5 受阻、26 通过 2 受阻，**均 0 未通过**。详见 [§13](#13-验收场景实测记录) |
| 真实联调状态 | **尚未用真实 DeepSeek Key 完成端到端联调**（环境无密钥）。无密钥/无效密钥两条路径已实测，见 §13 场景 B、C |

依赖锁定：`app/package-lock.json`（npm lockfileVersion 3），服务器用 `npm ci` 重建，**不要复制 Windows 的 `node_modules`**。

## 2. 环境要求与启动步骤

### 2.1 本机/服务器启动

```bash
cd app
npm ci                                  # 按锁文件安装；app/.npmrc 已设置 ignore-scripts（见 §12 说明）
npm run build
# 必要环境变量（示例值，真实值只放服务器环境）
export LIUYAO_OWNER_PASSWORD_HASH='scrypt$32768$8$1$...'   # echo "你的密码" | npm run hash-password
export DEEPSEEK_API_KEY='sk-...'
export LIUYAO_STORAGE_DIR=/srv/liuyao/storage               # 可选；默认 <项目根>/storage
npm start                                                   # 默认 http://127.0.0.1:3000
```

> 若不想使用仓库内的 `.npmrc`，等价命令是 `npm ci --ignore-scripts`。
> **不要**在装有 Visual Studio 的机器之外执行不带该设置的 `npm install`：
> better-sqlite3 包内有 `binding.gyp` 但没有自定义 install 脚本，npm 会默认调用 node-gyp 编译并失败
> （该包实际自带各平台预编译二进制，无需编译）。本次实测记录见 §13.5。

- 开发模式：`npm run dev`；类型检查：`npm run typecheck`。
- 反向代理 / HTTPS：见 [deploy/nginx.liuyao.conf.example](../deploy/nginx.liuyao.conf.example) 与
  [deploy/README.md](../deploy/README.md)。**必须关闭该聊天接口的响应缓冲与压缩**，否则会退化成“整段回答完成后一次显示”。
- `LIUYAO_PROJECT_ROOT` 可显式指定项目根目录；未设置时按当前工作目录推断（在 `app/` 内启动 → 上一级）。

### 2.2 首次登录

1. 生成口令哈希：`echo "你的密码" | npm run hash-password`，把输出写入 `LIUYAO_OWNER_PASSWORD_HASH`。
2. 启动服务（首次启动会建库、跑迁移、按环境变量创建拥有者账户）。
3. 打开 `/login` 输入密码；成功后进入 `/`（聊天界面）。

## 3. 环境变量与密钥处理

模板见 [.env.example](../.env.example)（含全部变量与注释）。要点：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是（联调） | **只从服务器环境读取**；缺失时聊天接口返回 `503 llm_not_configured`，页面显示明确提示，不泄露任何密钥信息 |
| `LIUYAO_OWNER_PASSWORD_HASH` | 二选一 | scrypt 哈希（推荐），启动时同步到数据库 |
| `LIUYAO_OWNER_PASSWORD` | 二选一 | 明文仅用于首次引导，服务立即哈希入库；数据库与日志中不会出现明文 |
| `LLM_BASE_URL` / `LLM_MODEL` | 否 | 默认 `https://api.deepseek.com` / `deepseek-flash` |
| `LLM_REASONING_EFFORT` | 否 | `none`（关闭思考，首段最快）/ `low` / `high`（默认）/ `max` |
| `LLM_MAX_OUTPUT_TOKENS` | 否 | 留空用官方默认；设置时注意**思考 token 计入该上限** |
| `LLM_TIMEOUT_MS` | 否 | 上游超时，默认 180000 |
| `LIUYAO_STORAGE_DIR` | 否 | 运行时数据目录，默认 `<项目根>/storage`，部署时必须持久化 |
| `LIUYAO_SESSION_TTL_DAYS` / `LIUYAO_COOKIE_SECURE` | 否 | 会话有效期 30 天；`Secure` 默认按请求协议自动判断（`auto`） |
| `LIUYAO_MAX_MESSAGE_CHARS` | 否 | 单条消息上限，默认 8000 |
| `LIUYAO_CONTEXT_MESSAGE_LIMIT` / `LIUYAO_CONTEXT_CHAR_BUDGET` | 否 | 单次请求上下文预算，默认 20 条 / 40000 字符 |
| `LIUYAO_LOGIN_MAX_ATTEMPTS` / `LIUYAO_LOGIN_WINDOW_MINUTES` / `LIUYAO_SENDS_PER_MINUTE` | 否 | 进程内限流 |
| `LIUYAO_FAKE_MODEL` | 否 | **仅验收用**：`1` 时启用本地假模型（不联网）。默认关闭，生产禁用 |
| `LIUYAO_PROJECT_ROOT` / `LIUYAO_MIGRATIONS_DIR` | 否 | 部署时显式指定路径 |

密钥处理约束的落实情况：

- API Key 只出现在服务端 `Authorization` 请求头；不写入代码、数据库、浏览器包、事件与日志。
- 浏览器包不含任何 `NEXT_PUBLIC_*` 机密；`/api/healthz` 只回答“是否已配置”（布尔）与模型名。
- 上游错误响应进入日志前统一脱敏（`sk-***`、`Bearer ***`），见 `app/src/server/llm/deepseek.ts` 的 `redactSecrets`。
- 日志不记录完整提问正文，只记录状态、模型、错误码、耗时。

## 4. 数据库、迁移、备份与恢复

### 4.1 数据模型（迁移 `app/migrations/0001_init.sql`）

| 表 | 关键字段 |
| --- | --- |
| `schema_migrations` | `version`、`name`、`applied_at` |
| `owners` | `id`、`username`（唯一）、`password_hash`（scrypt）、`password_updated_at`、时间戳 |
| `sessions` | `id`、`owner_id`、`token_hash`（SHA-256，唯一）、`created_at`、`last_seen_at`、`expires_at`、`revoked_at`、`user_agent` |
| `conversations` | `id`、`owner_id`、`client_conversation_id`（创建去重，与 owner 组合唯一）、`title`、`title_source`（`auto`/`manual`）、`created_at`、`updated_at`、`last_message_at` |
| `messages` | `id`、`conversation_id`、`owner_id`、`client_message_id`（用户消息去重）、`role`、`content`、`status`、`provider`、`model`、`prompt_version`、`error_code`、`input_tokens`、`output_tokens`、`total_tokens`、`latency_ms`、`created_at`、`updated_at`、`completed_at` |

- 状态机：用户消息保存即 `completed`；助手消息 `streaming → completed / interrupted / failed`。
- 时间戳统一为 ISO-8601 UTC 字符串（如 `2026-10-01T09:20:24.729Z`），页面按浏览器时区渲染；排序与分页不依赖客户端时钟。
- 历史分页按 SQLite `rowid`（插入顺序）稳定排序，避免同一毫秒时间戳导致顺序抖动。
- 连接参数：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`。

### 4.2 迁移机制

- 迁移文件为 `app/migrations/NNNN_名称.sql`，按文件名升序执行；每个文件在**独立事务**内执行并写入 `schema_migrations`。
- 服务启动（首次访问数据库）时自动迁移；无需单独执行迁移命令。生产升级只需替换应用并重启。
- 只读巡检：`cd app && npm run db:info`（打印迁移版本、WAL 模式、会话/消息计数与状态分布，不打印正文）。

### 4.3 备份

```bash
cd app
npm run db:backup
# 结果示例：storage/backups/liuyao-20261001-172500.db（自动做 PRAGMA integrity_check）
```

- 使用 SQLite 在线备份 API（`better-sqlite3` 的 `db.backup`），**服务运行中**也能得到一致快照，不会复制到写入一半的 WAL。
- 备份完成后立即用只读连接做 `integrity_check` 并统计会话/消息/迁移数量；校验不通过时脚本以非零码退出并提示不要覆盖生产库。

### 4.4 恢复

```bash
# 1) 停止服务（单实例，确保没有进程在写库）
# 2) 保留现场（可选但推荐）
cd <项目根>/storage && mv liuyao.db liuyao.db.before-restore
# 3) 用备份覆盖主库
cp backups/liuyao-20261001-172500.db liuyao.db
# 4) 关键：删除旧的 WAL/SHM，否则可能回放出旧内容
rm -f liuyao.db-wal liuyao.db-shm
# 5) 启动服务：自动校验/应用迁移
cd ../app && npm start
# 6) 复核：登录后历史会话应可见；npm run db:info 应显示一致计数
```

> 恢复演练已在验收存储目录执行过（见 §13.4）：重启后历史会话与消息状态完整可读。

## 5. HTTP 接口契约

所有接口：正文 UTF-8；普通接口为 JSON；错误统一为 `{"error":{"code","message","details?}}`；
会话类接口先校验登录态与归属；**变更类接口（POST/PATCH）额外校验同源 `Origin`**。
会话 ID 为随机 UUID v4（不可预测）。

| 方法与路径 | 输入 | 输出 | 关键约束 |
| --- | --- | --- | --- |
| `POST /api/auth/login` | `{password}` | `{owner:{id,username}, expiresAt}` + `Set-Cookie` | 错误一律 `401 invalid_credentials`；按 IP 限流（默认 10 次 / 15 分钟）；未配置口令时 `503 auth_not_configured` |
| `POST /api/auth/logout` | 空 | `{loggedOut:true}` | 撤销服务端会话并清 Cookie；幂等 |
| `GET /api/auth/me` | 空 | `{authenticated:true, owner}` | 未登录 `401 auth_required` |
| `GET /api/conversations?cursor=&limit=` | 查询参数 | `{items:[ConversationSummary], nextCursor}` | 按 `updated_at` 倒序；**不返回空草稿**；`limit` 默认 20、上限 100 |
| `POST /api/conversations` | `{clientConversationId}` | `{id,title,titleSource,createdAt,updatedAt,created}` | 同一 `clientConversationId` 幂等（重试不重复建会话）；新建返回 `201` |
| `GET /api/conversations/{id}` | 空 | `{conversation}` | 不含完整历史 |
| `GET /api/conversations/{id}/messages?before=&limit=` | 查询参数 | `{items:[MessageDto], nextCursor, hasMore}` | 按插入顺序升序返回；`before` 为更早消息游标；`limit` 默认 50、上限 200 |
| `PATCH /api/conversations/{id}` | `{title}` | `{conversation}` | 去首尾空白、折叠空白、上限 80 字符；写入 `title_source=manual` |
| `POST /api/conversations/{id}/messages` | `{clientMessageId, content, model?}` | `text/event-stream` | 先存用户消息再调模型；重复 `clientMessageId` → `409 duplicate_message`；同会话并发生成 → `409 generation_in_progress` |
| `GET /api/healthz` | 空 | `{status,time,version,database,llm,auth}` | 不暴露密钥、路径或数据库内容 |

### 5.1 请求/响应示例

登录：

```http
POST /api/auth/login
Content-Type: application/json

{"password":"<服务器配置的密码>"}
```

```http
HTTP/1.1 200 OK
Set-Cookie: liuyao_session=<随机令牌>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000

{"owner":{"id":"8b1d...","username":"owner"},"expiresAt":"2026-10-31T09:20:00.000Z"}
```

创建会话（首条消息前调用；重试返回同一条）：

```http
POST /api/conversations
Content-Type: application/json

{"clientConversationId":"3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607"}
```

```json
{"id":"0f6c...","title":"","titleSource":"auto","createdAt":"2026-10-01T09:20:00.000Z","updatedAt":"2026-10-01T09:20:00.000Z","created":true}
```

发送问题并流式接收（见 §6）；历史分页：

```http
GET /api/conversations/0f6c.../messages?limit=50
```

```json
{
  "items": [
    {"id":"...","conversationId":"0f6c...","role":"user","content":"…","status":"completed","provider":null,"model":null,"promptVersion":null,"errorCode":null,"createdAt":"2026-10-01T09:20:01.000Z","updatedAt":"2026-10-01T09:20:01.000Z","completedAt":"2026-10-01T09:20:01.000Z","usage":null},
    {"id":"...","conversationId":"0f6c...","role":"assistant","content":"…","status":"completed","provider":"deepseek","model":"deepseek-flash","promptVersion":"phase1-v1","errorCode":null,"createdAt":"2026-10-01T09:20:01.100Z","updatedAt":"2026-10-01T09:20:09.000Z","completedAt":"2026-10-01T09:20:09.000Z","usage":{"inputTokens":123,"outputTokens":45,"totalTokens":168}}
  ],
  "nextCursor": null,
  "hasMore": false
}
```

重命名：

```http
PATCH /api/conversations/0f6c...
Content-Type: application/json

{"title":"乾卦六爻解释"}
```

```json
{"conversation":{"id":"0f6c...","title":"乾卦六爻解释","titleSource":"manual","createdAt":"…","updatedAt":"…","lastMessageAt":"…","messageCount":4,"lastMessageStatus":"completed","lastModel":"deepseek-flash"}}
```

### 5.2 错误码

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 400 | `invalid_request` | 缺字段、空白消息、超长、非法 `clientConversationId`/`cursor` |
| 401 | `auth_required` / `invalid_credentials` | 未登录 / 密码错误 |
| 403 | `forbidden_origin` | 变更类接口的 `Origin` 与本机 Host 不一致 |
| 404 | `not_found` | 会话不存在或不属于当前拥有者 |
| 409 | `duplicate_message` / `generation_in_progress` | 重复 `clientMessageId` / 同会话已有生成任务 |
| 413 / 415 | `invalid_request` | 请求体过大 / 非 JSON |
| 429 | `rate_limited` | 登录或发送频率超限（附 `retryAfterSeconds`） |
| 500 | `internal_error` | 服务端异常（不返回内部细节） |
| 503 | `llm_not_configured` / `auth_not_configured` | 未配置 API Key / 未配置拥有者口令 |

流已开始后的错误不再使用 HTTP 状态码，改用 SSE `error` 事件（见 §6.3）。

## 6. SSE 事件契约

### 6.1 事件

| 事件 | 数据 | 说明 |
| --- | --- | --- |
| `start` | `{conversationId,userMessageId,assistantMessageId,provider,model,promptVersion,conversationTitle?}` | 用户消息与助手占位已入库；`conversationTitle` 仅在首条消息生成自动标题时出现 |
| `delta` | `{text}` | 增量正文（不含思考过程） |
| `done` | `{assistantMessageId,status,usage:{inputTokens,outputTokens,totalTokens},errorCode?}` | `status` 为 `completed` 或 `interrupted` |
| `error` | `{code,message,assistantMessageId,status}` | 生成失败；发送后关闭流。`message` 为可读中文，`code` 为稳定错误码 |

- 保活：每 15 秒发送一条 SSE 注释（`: keepalive`），思考模式下首段正文较慢时连接不会被中间层掐断。
- 响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-store, no-transform`、`X-Accel-Buffering: no`。
- 增量解析：客户端用 `TextDecoder({stream:true})` 处理**UTF-8 字符被网络分块切开**的情况，按空行切帧；服务端同样以流式解码器解析上游。
- 上游 DeepSeek 的原始事件**不会**透传；页面协议在接入千问后保持不变。

### 6.2 真实抓取示例（验收环境，假模型）

完整文件：[docs/evidence/phase1/sse-sample.txt](evidence/phase1/sse-sample.txt)（211 帧：`start → delta ×208 → comment(保活) → done`）。

```text
event: start
data: {"conversationId":"e2a07f9f-1b44-4706-8983-aea62e209fde","userMessageId":"9aa5aa0f-7899-45b3-9465-364ced102ed4","assistantMessageId":"91558c1b-90a3-40b4-ba24-7d1c3f413e15","provider":"fake","model":"fake-stream-v1","promptVersion":"phase1-v1","conversationTitle":"请用一句话说明：当前版本是否已经接入 Wiki …"}

event: delta
data: {"text":"（"}

event: delta
data: {"text":"验"}

# …（省略 202 帧，主要是 delta 增量与 1 条保活注释）…

event: done
data: {"assistantMessageId":"91558c1b-90a3-40b4-ba24-7d1c3f413e15","status":"completed","usage":{"inputTokens":0,"outputTokens":208,"totalTokens":208}}
```

用真实 DeepSeek 时，`provider` 为 `deepseek`、`model` 为 `deepseek-flash`（或 `LLM_MODEL` 指定值），
`usage` 来自上游最后一个带 `usage` 的块（含思考 token 的 `completion_tokens`）。

### 6.3 失败示例（无效 API Key，实测）

```text
event: start
data: {"conversationId":"…","userMessageId":"…","assistantMessageId":"…","provider":"deepseek","model":"deepseek-flash","promptVersion":"phase1-v1"}

event: error
data: {"code":"upstream_auth_error","message":"模型服务拒绝了本次调用（API Key 无效或无权限）。","assistantMessageId":"…","status":"failed"}
```

同时数据库里该助手消息保存为 `status=failed`、`error_code=upstream_auth_error`，已收到的部分内容（此处为空）保留。

## 7. 页面行为

- **左侧**：新建聊天按钮；按 `updated_at` 倒序的历史会话（标题、更新时间、`手动标题` 标记、`生成中/已中断/失败` 标记）；每条会话有「重命名」入口（回车保存、Esc 取消）；底部显示当前拥有者与退出。
- **主区标题**：当前会话标题旁同样提供「重命名」（就地编辑、回车保存、Esc 取消）。列表与主区改的是**同一个会话属性**，都走 `PATCH /api/conversations/{id}` 并置为 `manual`。
- **主区**：消息列表区分用户/助手；助手消息显示所用模型、时间、状态徽标与输出 token 数；生成中显示逐字内容与光标；失败/中断显示可读原因。
- **底部**：多行输入框（Enter 发送、Shift+Enter 换行、**中文输入法选词回车不误发**）、发送按钮、生成中变为「停止生成」；空白消息不可发送并显示字数。
- **小屏幕**（≤860px）：历史列表变为可开合抽屉（点击遮罩关闭）。
- **刷新与切换**：默认自动打开最近一次会话；生成过程中禁止切换会话与新建（避免同一会话并发请求），并以服务端历史为准刷新列表与消息状态。
- **Markdown 安全渲染**：不渲染原始 HTML（`react-markdown` 默认跳过，未启用 `rehype-raw`）；链接仅允许 `http/https` 并强制 `target=_blank rel="noopener noreferrer nofollow"`；**模型插入的图片不会被自动加载**（渲染为链接文本）。
- **能力边界提示**：页面顶部与空状态明确写出“尚未接入 Wiki 资料与排盘程序”，系统提示词禁止声称已读资料或编造卦盘。

## 8. 模型适配层边界（后续扩展点）

```ts
// app/src/server/llm/types.ts
interface LlmProvider {
  id: string; label: string; defaultModel: string;
  isConfigured(): boolean;
  listModels(): string[];
  streamChat(options: {model; messages; signal; maxOutputTokens?}, handlers: {onDelta; onUsage?}): Promise<LlmStreamResult>;
}
```

- DeepSeek 实现：`app/src/server/llm/deepseek.ts`。请求体固定 `stream:true`、`stream_options.include_usage:true`、`reasoning_effort`（默认 `high`）；解析 `choices[0].delta.content`；`finish_reason` 映射为状态：`stop→completed`、`length→completed+output_limit_reached`、`content_filter→failed`、`insufficient_system_resource→failed`、`aborted→interrupted`。
- 思考模式：`delta.reasoning_content` **不推送、不入库**（避免把推理过程写入历史），但思考 token 计入用量。
- 应用层只依赖上述统一接口；接入千问（阶段 4）只需新增一个 `LlmProvider` 并注册，SSE 协议与页面不变。
- 阶段 2/3 的 Wiki 片段与排盘结果将从 `startChatStream` 构造上下文的位置接入（当前只有系统提示词 + 数据库中的近期消息）。

**验收用假模型**（`app/src/server/llm/fake.ts`）：仅 `LIUYAO_FAKE_MODEL=1` 时注册，模型名为 `fake-stream-v1`，
输出首行自述“验收用假模型输出，未调用 DeepSeek”，页面顶部显示醒目提示；它**只**用于在没有密钥的机器上验证
SSE 通道、停止生成与持久化，**不代表 DeepSeek 联调通过**。默认关闭，生产环境不得启用。

## 9. 已完成的阶段 1 需求清单

对照任务书逐条（✔ 已实现并自检通过；◐ 已实现但需真实密钥才能完成端到端验证）：

| # | 任务书要求 | 状态 | 实现位置 / 证据 |
| --- | --- | --- | --- |
| 2 | Node LTS + TypeScript + Next.js App Router，自托管非静态导出 | ✔ | `app/next.config.ts`、`next build` 输出全部路由为 `ƒ (Dynamic)` |
| 2 | 依赖版本锁定 | ✔ | `app/package-lock.json`（精确版本 + `npm ci`） |
| 2 | DeepSeek 官方 `deepseek-flash` 流式 + 统一事件 | ◐ | `app/src/server/llm/deepseek.ts`；错误处理与协议已实测（场景 C），成功路径待密钥 |
| 2 | SQLite + better-sqlite3 + 版本化迁移 + `storage/` | ✔ | `app/migrations/0001_init.sql`、`app/src/server/db/*`；自检显示迁移 1 个、WAL 已启用 |
| 2 | 单拥有者登录、强哈希、安全 Cookie、接口需登录 | ✔ | `app/src/server/auth/*`；自检项“未登录被拒绝”“Cookie 属性 httponly+samesite=lax” |
| 3.1 | 左侧新建/历史/标题/重命名，主区消息流与状态，底部输入/发送/停止 | ✔ | `app/src/components/ChatApp.tsx`、`globals.css`；**主区标题与左侧列表都能重命名同一会话**（交接说明第 9 条） |
| 3.1 | Enter 发送 / Shift+Enter 换行 / 空白不可发送 / 小屏可开合 | ✔ | 同上（含中文输入法 `isComposing` 保护） |
| 3.1 | 助手内容安全渲染 Markdown，不执行 HTML/脚本/任意链接 | ✔ | `app/src/components/MarkdownContent.tsx` |
| 3.2.1 | 新建先进空白草稿，首条消息才建会话 | ✔ | 草稿 `clientConversationId`；自检“同一草稿 ID 不重复建会话”“空草稿不出现在列表” |
| 3.2.2 | 首条消息生成简短默认标题（不调 LLM）；手动标题不被覆盖 | ✔ | `app/src/server/chat/title.ts`；自检“手动标题不被后续消息覆盖” |
| 3.2.3 | 列表按 `updated_at` 倒序；重开会话可继续 | ✔ | `listConversations` + `refreshAfterGeneration` |
| 3.2.4 | 同会话仅一个进行中请求；停止标 `interrupted` 并保留部分内容 | ✔ | `app/src/server/chat/in-flight.ts`、`stream-service.ts`；自检“停止生成后状态=interrupted、无永久 streaming” |
| 3.2.5 | 失败/重启可辨认；重发不产生重复用户消息 | ✔ | 启动恢复 `recoverInterruptedMessages`；`client_message_id` 唯一约束 → `409 duplicate_message` |
| 3.2.6 | 历史长期保存；上下文按可配置预算 | ✔ | `LIUYAO_CONTEXT_MESSAGE_LIMIT` / `LIUYAO_CONTEXT_CHAR_BUDGET`、`buildModelContext` |
| 3.2 | 仅显示 DeepSeek Flash；历史保存当时模型名 | ✔ | `AVAILABLE_MODELS`、`messages.model` |
| 4 | 全部接口契约（登录/登出/me/列表/建会话/详情/消息分页/重命名/发消息/healthz） | ✔ | `app/src/app/api/**`；自检覆盖鉴权、幂等、分页、重命名、错误码 |
| 4.1 | SSE `start/delta/done/error`、保活、不缓存、UTF-8 分块安全 | ✔ | `app/src/server/http/sse.ts`、`app/src/lib/api-client.ts`；真实抓帧见 §6.2 |
| 4.2 | 短事务先存消息→释放→调模型；增量定期落库；结束保存状态与用量 | ✔ | `app/src/server/chat/stream-service.ts` |
| 4.2 | 重启后遗留 `streaming` 标为 `interrupted` | ✔ | `recoverInterruptedMessages`（启动日志会打印恢复条数） |
| 5 | 三张表 + 迁移 + WAL + 备份恢复说明 | ✔ | §4；用量随 `messages` 保存 |
| 6 | 服务端读密钥；缺密钥明确报错且不泄露 | ✔ | 自检“缺少 API Key 时返回安全错误”“不产生半条会话记录” |
| 6 | 固定系统提示词：简明、事实/推测分开、缺证据说明、末尾「最终结果」 | ✔ | `app/src/server/prompt.ts`（`PROMPT_VERSION=phase1-v1`，写入 `messages.prompt_version`） |
| 6 | 不把整段长期历史/原件/未用 Wiki 发给 API | ✔ | 仅系统提示词 + 近期消息；`corpus/`、`wiki/` 本阶段完全未读取 |
| 7 | 密钥/口令只经环境注入；变更接口跨站保护；长度限制；分页；安全渲染 | ✔ | §3；`checkSameOrigin` + SameSite=Lax + 输入校验 + 分页上限 |
| 8 | 备份恢复说明、接口与 SSE 示例、启动部署说明 | ✔ | §2、§4、§5、§6；备份脚本 `npm run db:backup` |

## 10. 尚未完成 / 受环境限制的项目

| 项目 | 状态与原因 | 解除条件 |
| --- | --- | --- |
| **真实 DeepSeek 端到端联调** | 本机无 `DEEPSEEK_API_KEY`。已实测：无密钥→`503 llm_not_configured`（不产生半条会话）；无效密钥→上游 `401` 被归类为 `upstream_auth_error`，助手消息存为 `failed`，无永久 `streaming` | 配置真实 Key 后重跑 `npm run verify:phase1`，预期“首段内容早于生成结束到达”等项由“受阻”转为“通过” |
| 千问 `qwen3.7-plus` 选择入口 | 属阶段 4；本阶段只显示 DeepSeek Flash | 阶段 4 |
| Wiki 阅读、来源引用、`sources` 事件 | 属阶段 2；当前 Wiki 只有试点内容，页面明确说明未接入 | 阶段 2 |
| 六爻排盘、盘面快照、`chart_runs` | 属阶段 3；提示词禁止编造卦盘，页面提示需补齐输入 | 阶段 3 |
| `message_sources` / `chart_runs` / `model_usage` 表 | 按任务书 §5 的最小表集交付；无来源/排盘/多服务商时建空表无实际价值 | 阶段 2/3/4 随功能加迁移 |
| P1：删除/导出会话、历史搜索、资料状态页 | 产品需求列为 P1，首版稳定后安排 | 后续阶段 |
| 「重新生成」上一轮失败回复 | 本阶段未提供；失败后用户消息已保存，重发会命中 `duplicate_message` 去重，界面提示改为继续追问 | 需要新增单独的重试接口 |
| HTTPS/`Secure` Cookie、反向代理流式实测 | 本机为 HTTP；`Secure` 采用 `auto` 按请求协议判断。已给出 nginx 配置示例与要点，但**未在真实 nginx 后实测** | 提供服务器/代理环境 |
| 浏览器端交互自动化测试 | 已通过服务端渲染检查与 HTTP 层完整链路验证，但**没有用真实浏览器**验证 React 水合、点击“发送/停止”、Markdown 渲染与移动端抽屉；客户端协议解析与事件处理逻辑有单元级保证（`createSseParser`）与同源 HTTP 实测 | 引入 Playwright 等浏览器自动化环境 |
| 多实例部署 | 会话、并发登记、限流均为进程内状态，设计为**单实例** | 若需横向扩展需引入共享存储 |
| 登录尝试的持久化限流 | 进程内固定窗口，重启清零 | 如需跨重启限制，改用数据库计数 |

## 11. 文档冲突与处理理由

按要求以任务书与最新用户要求为准，冲突处**未改写产品需求**，处理如下：

1. **早期草案的 Python/FastAPI 架构**：`docs/implementation_plan.md` 与 `docs/agent_design_v0.md` 仍描述 Python 服务，
   与用户决策的 Node.js/TypeScript 冲突。两份文档顶部已标注“Python/FastAPI 已被取代”，本次**保留原文不改写**，实现按 Node 架构执行。
2. **接口表差异**：技术架构 §3 的普通 API 表含 `GET /api/sources/{sourceId}`，任务书 §4 的表没有它。
   该接口依赖阶段 2 的来源页，**本阶段不实现**（避免提供无数据来源的端点）。
3. **SSE 事件差异**：技术架构列出的流式事件含 `sources`，任务书 §4.1 的“至少定义”为 `start/delta/done/error`。
   本阶段无来源可引用，**只发后者**；`sources` 预留给阶段 2，接入时不破坏现有协议。
4. **数据模型差异**：技术架构 §4 列出 `message_sources`、`chart_runs`、`model_usage` 三张表，任务书 §5 只要求
   `conversations` / `messages` / `sessions`。本阶段按任务书实现最小表集，用量字段直接落在 `messages`
   （`input_tokens`/`output_tokens`/`total_tokens`/`latency_ms`），**暂不建空表**；阶段 2/3/4 随功能补迁移。
5. **`POST /api/conversations` 返回字段**：任务书写 `{id,title,createdAt}`，实现额外返回 `titleSource`、`updatedAt`、
   `created`（幂等命中时为 `false`）。语义未变，字段只增不减，已在 §5 记录最终形态。
6. **产品需求 §2 的“六次爻值输入区”“展开依据”**：标为 P0 但依赖排盘与 Wiki（阶段 2/3）。本阶段不提供，
   且在系统提示词与页面提示中如实说明能力边界，**未修改产品需求文档**。
7. **“聊天输入框可以重命名”**：按任务书 §1 与产品需求 §5 的暂定解释，实现为**会话标题可重命名**；
   如用户澄清为输入框提示语可编辑，只需改界面文案，不影响存储结构。
8. **模型名**：已核对官方文档，`deepseek-flash` 是当前有效模型名（DeepSeek-V4.1-Flash，1M 上下文，默认思考模式），
   与任务书一致；模型名可通过 `LLM_MODEL` 覆盖而无需改代码。

## 12. 关键技术取舍

| 取舍 | 选择与理由 | 代价 |
| --- | --- | --- |
| 口令哈希 | Node 内置 **scrypt**（N=2^15, r=8, p=1, 16B 盐），不引入 bcrypt/argon2 原生依赖 | 部署机无需编译工具链；参数写入哈希串，将来可升级 N |
| SQLite 驱动 | **better-sqlite3 13**：同步 API、事务简单，且该版本自带预编译原生模块（安装脚本为空），服务器无需 node-gyp | 同步 API 不适合高并发；单用户场景足够。`node:sqlite` 仍为 RC，未采用 |
| 登录态 | **服务端会话 + Cookie 只放随机令牌、库中只存 SHA-256**，可撤销、可过期 | 每次请求一次数据库查询（单用户可忽略）；滑动续期只在剩余有效期不足一半时写库 |
| 实时传输 | `fetch()` + `POST` 读 SSE：请求体可带问题，比 `EventSource`（仅 GET）合适；比 WebSocket 简单 | 需自行解析 SSE 帧并处理分块 UTF-8（已实现并测试） |
| 事务边界 | 用户消息与助手占位于**短事务**内写入后立即释放，再调用模型；生成过程不持有事务 | 模型调用期间库处于可写状态，靠状态机与并发登记保证一致性 |
| 增量落库 | 每 `LIUYAO_STREAM_PERSIST_INTERVAL_MS`（默认 1s）保存已生成文本 | 极端崩溃时最多丢约 1 秒内容；换取写放大可控 |
| 并发控制 | 进程内登记表 + 数据库 `streaming` 兜底；启动时把遗留 `streaming` 标为 `interrupted` | 仅适用单实例；多实例需外部协调 |
| 停止与完成竞态 | 用户中止会立即中止上游；**若上游已在同一瞬间正常完成，则保存为 `completed`** | 避免把完整回复误标为中断；绝大多数停止仍为 `interrupted`（已实测） |
| 前后端一致性 | 生成结束后**以服务端历史为准**重新拉取，而不是信任本地状态机 | 多一次请求；换来状态、用量、模型名与数据库完全一致 |
| 重命名与排序 | 重命名**不修改** `updated_at`（排序代表“对话活动时间”） | 重命名不会把会话顶到列表最前（有意为之） |
| Markdown 安全 | 不渲染原始 HTML、链接协议白名单、图片不自动加载 | 模型若输出 HTML 只会显示为文本；换取无 XSS 与无外链跟踪 |
| 上下文预算 | 历史**全部长期保存**，单次请求只取最近 N 条 + 字符预算 | 两件事分离，符合任务书 §3.2.6 |
| 假模型 | 提供**仅验收使用**的本地假模型（默认关闭、模型名自证、页面告警） | 让无密钥环境也能验证 SSE/停止/持久化链路；绝不被当作 DeepSeek 联调证据 |
| Windows 脚本编码 | `app/scripts/acceptance-run.ps1` 保持纯 ASCII | Windows PowerShell 会把无 BOM 的 UTF-8 `.ps1` 当 ANSI 读，中文注释会吞掉下一行（本次已实际踩到并修复） |
| 安装期脚本 | `app/.npmrc` 设 `ignore-scripts=true`：依赖无需编译，better-sqlite3 自带预编译二进制 | 隐藏了未来依赖可能需要安装脚本的风险；新增依赖时必须复核其安装脚本（`.npmrc` 内已写明） |

## 13. 验收场景实测记录

### 13.1 环境与命令

- 机器：Windows（Laptop-28UKBFPT），Node **v22.20.0**，端口 **3100**，数据库位置 `storage/verify-*/liuyao.db`。
- 构建：`node node_modules/next/dist/bin/next build` → 成功，全部业务路由为动态渲染。
- 类型检查：`npx tsc --noEmit` → 无输出（通过）。
- 三种配置分别启动真实服务并运行黑盒自检（`app/scripts/verify-phase1.mjs`）：

```powershell
# A. 本地验收用假模型（覆盖流式、停止、持久化、重启恢复）
powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-fake -FakeMode -Rebuild -RestartCheck
# B. 未配置 API Key
powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-nokey
# C. 无效 API Key（真实访问 api.deepseek.com，验证失败处理；不代表调用成功）
powershell -File app/scripts/acceptance-run.ps1 -Storage <root>\storage\verify-badkey -ApiKey sk-invalid-for-verification-only
```

> 验收脚本使用的拥有者口令是**本机一次性口令**（`acceptance-run.ps1` 的 `-Password` 默认值，
> 仅写入验收用的独立存储目录），与生产环境口令无关；生产口令只存在于服务器环境变量中。
> 无效 Key 用 `-ApiKey` 显式传入，只出现在本次进程环境里，不写文件、不入库。

### 13.2 结果汇总

| 场景 | 通过 | 未通过 | 受阻 | 退出码 | 原始输出 |
| --- | --- | --- | --- | --- | --- |
| A 假模型 + 构建 + 重启复核 + SSE 抓帧 | **29** | **0** | 0 | 0 | [run-A-fake-model.txt](evidence/phase1/run-A-fake-model.txt) |
| B 未配置 API Key | 21 | **0** | 5（均需密钥） | 0 | [run-B-no-api-key.txt](evidence/phase1/run-B-no-api-key.txt) |
| C 无效 API Key | 26 | **0** | 2（无法比较首段时序/无生成可停止） | 0 | [run-C-invalid-api-key.txt](evidence/phase1/run-C-invalid-api-key.txt) |
| E 备份恢复演练 | – | – | – | 0 | [run-E-restore.txt](evidence/phase1/run-E-restore.txt) |
| F 冻结修订复验（不重新构建，其余同 A） | **29** | **0** | 0 | 0 | [run-F-final-state.txt](evidence/phase1/run-F-final-state.txt) |

> 场景 A/F 的抓帧步骤产出 [sse-sample.txt](evidence/phase1/sse-sample.txt)（真实 211 帧）。
> B/C 的通过数多于早先版本，是因为脚本后来加入了 3 项服务端页面渲染检查（对未配置密钥的场景同样适用）。

### 13.3 任务书 §8 的验收场景逐条对照

| 场景 | 实测结果（场景 A，假模型；括号内为真实 DeepSeek 待验证部分） |
| --- | --- |
| 登录 | 通过：正确口令 `200` + `Set-Cookie`（HttpOnly、SameSite=Lax）；错误口令统一 `401 invalid_credentials` |
| 页面渲染 | 通过（服务端渲染层面）：登录后 `/` 返回 200 且含新建按钮、输入框与标题；未登录 `/` 返回 `307 → /login`；`/login` 含密码输入框。**浏览器端交互（React 水合、点击发送/停止、Markdown 渲染）未做自动化测试**，见 §10 |
| 新建会话 | 通过：`201`，返回会话 ID；同一草稿 ID 再次调用返回同一条（`created=false`） |
| 流式问答 | 通过：`start → delta ×208 → done`（210 帧，另有保活注释）；**首个 delta 133ms、`done` 25854ms**，证明首段内容早于全部完成到达浏览器（真实模型下同样由服务端边收边推） |
| 停止一次生成 | 通过：点停止后助手消息 `interrupted`、保留已收到内容（本次 1 字符）、无永久 `streaming` |
| 再次发送并完成 | 通过：同会话继续追问，消息保存为 `completed`，会话 `updated_at` 前移 |
| 重命名会话 | 通过：`PATCH` 返回 `titleSource=manual`；再发消息后标题**未被自动覆盖** |
| 刷新页面 | 通过：重新登录（模拟新浏览器/刷新）后仍能读到全部历史消息（6 条） |
| 重启服务 | 通过：重启后重新登录，历史会话 1 条、消息 6 条，状态分布 `{completed:5, interrupted:1}`，模型名保留 |
| 从历史打开并继续 | 通过：列表按 `updated_at` 倒序，打开后消息完整、可继续追加 |
| 未登录访问被拒绝 | 通过：`GET /api/conversations`、`/api/auth/me` 均 `401 auth_required`；退出登录后历史接口不可访问 |
| 缺少 API Key 的安全错误 | 通过（场景 B）：`503 llm_not_configured`，响应不含密钥片段，且**不产生半条会话记录** |
| 网络/模型故障 | 通过（场景 C）：上游 `401` → `error` 事件 `upstream_auth_error`，助手消息存为 `failed`，无永久 `streaming`，重复发送被 `409 duplicate_message` 拦住 |
| 重复用户消息 | 通过：同一 `clientMessageId` 第二次发送返回 `409 duplicate_message`，数据库中该内容只有 1 条用户消息 |
| 流式在代理后仍逐步显示 | **未实测**（本机无反向代理）。已提供 nginx 配置示例与必需项（关闭 buffering/gzip、放宽 read timeout） |

### 13.4 备份与恢复演练（实测）

备份（`cd app && npm run db:backup`，实际输出）：

```text
备份完成：<root>/storage/verify-fake/backups/liuyao-20261001-214831.db
大小：73728 字节
完整性检查：ok
会话 2 条 / 消息 8 条 / 迁移 1 个
存储目录：<root>/storage/verify-fake
```

注意：主库文件当时只有 4096 字节，数据还在 `-wal` 里；备份 73728 字节且 `integrity_check=ok`，
正好说明必须用备份 API 而不是直接复制 `.db` 文件。

恢复演练（按 §4.4 的步骤：停止服务 → 备份覆盖主库 → 删除旧 `-wal`/`-shm` → 启动）：

```text
=== restore drill: read history from the restored database ===
重启后仍可登录，历史会话 2 条：
  - 「请用一句话说明：当前版本是否已经接入 Wiki …」 消息 2 条，状态 {"completed":2}，模型 fake-stream-v1
  - 「验收自检会话（手动标题）」 消息 6 条，状态 {"completed":5,"interrupted":1}，模型 fake-stream-v1
数据库文件：..\storage\verify-restore\liuyao.db（73728 字节）
本次抽查的消息总数：8
```

恢复后会话数、消息数、状态分布与备份前完全一致。证据文件：
[run-E-restore.txt](evidence/phase1/run-E-restore.txt)。

此外，场景 A/F 的 `-RestartCheck` 也验证了“重启服务后历史仍可读”：
`重启后仍可登录，历史会话 1 条 … 消息 6 条`。

### 13.5 依赖安装方式实测（重要）

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm install --ignore-scripts` | 成功（134 包） | 首次安装使用；better-sqlite3 直接使用包内 `prebuilds/win32-x64.node`，`require()` 冒烟测试通过 |
| `npm ci`（未设置 `.npmrc`） | **失败（exit 1）** | npm 对含 `binding.gyp` 且无自定义 install 脚本的包默认执行 `node-gyp rebuild`，本机无 Visual Studio → `gyp ERR! find VS` |
| `npm ci` + `app/.npmrc`（`ignore-scripts=true`） | 成功（exit 0，9 秒） | 当前交付方式；随后 `better-sqlite3` 冒烟测试输出 `ok { c: 1 }`，构建与自检全部通过 |

结论：交付包内保留 `app/.npmrc`，服务器与本地都统一用 `npm ci`。若将来新增需要安装脚本的依赖，
必须复核并调整该设置。

### 13.6 服务端日志（确认不含密钥）

场景 A 的 `storage/verify-fake/server-first.err.log` 尾部：

```text
[liuyao] 已启用 LIUYAO_FAKE_MODEL=1：聊天由本地假模型生成，未调用 DeepSeek。仅用于验收链路，请勿用于正式使用。
[liuyao] 生成结束 status=interrupted model=fake-stream-v1 code=client_aborted detail=假模型：客户端中止
```

进入日志的上游错误摘要先经过脱敏函数（把 `sk-***`、`Bearer ***` 形式替换掉）并截断到 300 字符以内；
本次上游自身也把密钥显示为 `****only`。请求头里的 `Authorization` 从不写入日志或数据库。

## 14. 已知限制与后续建议

1. **必须在配置真实 `DEEPSEEK_API_KEY` 后重跑** `npm run verify:phase1`，把 §13 中标注“受阻”的项转为通过，
   并确认思考模式下的首段延迟、真实用量字段与 `finish_reason` 映射。
2. 建议部署时用 systemd（单实例）并把 `storage/` 挂到持久化目录；**多副本会破坏会话/限流语义**。
3. 反向代理上线后，用页面观察“首段是否在生成结束前出现”，并确认 `X-Accel-Buffering: no` 与 `proxy_buffering off` 生效。
4. 「重新生成」尚未提供；若需要，建议新增 `POST /api/conversations/{id}/messages/{assistantMessageId}/regenerate`
   （复用已保存的用户消息，不重复插入）。
5. 历史管理（删除/导出/搜索）为 P1；删除需级联清理并保留备份策略。
6. 阶段 2 接入 Wiki 时，请把“已选页面 + 来源 ID + 定位”随消息快照保存，并新增 `sources` 事件；
   本阶段的 `startChatStream` 已预留上下文构造位置。
