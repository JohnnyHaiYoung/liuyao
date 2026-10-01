# 六爻 Agent 技术架构（交付开发用）

版本：2026-10-01。以 [产品需求](product_requirements.md) 为输入。首版是**一个 Node.js/TypeScript 服务承载网页、API、Wiki 读取与 Agent 编排**；离线资料转换可调用专门的文档/OCR 工具，但生产问答服务不以 Python 为前提。

## 1. 已选方案与原因

| 决策 | 首版选择 | 原因及边界 |
| --- | --- | --- |
| 网站与 API | Next.js App Router + TypeScript，自托管 Node.js 运行时 | 同一项目交付聊天页面和服务端路由，能读取本地 Wiki 并返回流式响应。须以 Node 服务部署，不能用纯静态导出。[Next.js Route Handler](https://nextjs.org/docs/app/api-reference/file-conventions/route) |
| 实时回复 | `POST` 请求返回 `text/event-stream`；浏览器用 `fetch()` 读取流 | 一次请求携带问题并持续接收 `delta`、`done` 等事件。原生 `EventSource` 是服务端向浏览器的单向连接；此处需要在请求体提交问题，故用 `fetch` 消费 SSE 格式。历史列表用普通 JSON API。[MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) |
| 持久化 | 本机 SQLite 文件 + `better-sqlite3`，版本化 SQL 迁移；数据访问封装为独立模块 | 个人使用、单实例和聊天记录写入量适合 SQLite。PostgreSQL 目前不需要安装；只有多用户、多个服务实例或高并发写入时再迁移。[SQLite 适用场景](https://www.sqlite.org/whentouse.html)、[驱动说明](https://github.com/WiseLibs/better-sqlite3) |
| LLM | DeepSeek 官方 API 为默认；阿里云百炼 `qwen3.7-plus` 可切换 | 统一模型接口，按调用记录服务商、模型和用量；各家的鉴权及消息/图片格式由适配器处理 |
| 知识 | `wiki/index.md` + 主题元数据 + 明确链接，按需读取项目文件 | 无 embedding 或向量数据库；清洗全文只作为证据回查，不在每次对话中全部送入模型 |
| 计算 | TypeScript 适配器 + 经核对的排盘模块 + 独立历法模块及版本化规则配置 | 模型不能生成或修改确定性盘面字段；优先评估现有 JavaScript 排盘核心，审查后再决定复用或重写 |
| 部署 | 单个 Node 应用容器或单进程 + 持久化 `storage/` | 应用、Wiki、原件副本、清洗文本和已采用的 Skill 同包；聊天数据库、备份与日志在独立可写目录 |

`better-sqlite3` 是同步 API，单用户的短事务可接受；生成模型回复时不得保持数据库事务打开。建议启用 WAL，使用参数化 SQL，并通过数据访问模块隔离存储实现。`node:sqlite` 在当前 Node 官方文档仍标为 release candidate，因此首版不依赖它。[驱动说明](https://github.com/WiseLibs/better-sqlite3)、[Node.js SQLite 文档](https://nodejs.org/api/sqlite.html)

## 2. 项目目录契约

```text
liuyao/
├─ app/                 # Next.js/TypeScript 项目：页面、API、服务端模块
├─ corpus/              # 原件、提取/清洗文本、图片、manifest 和质量报告
├─ wiki/                # 来源页、概念页、体系/对照页、索引
├─ skills/              # 审查并采用的 Skill 快照及本项目适配器
├─ storage/             # 运行时数据库、备份、日志；部署时持久化，不覆盖
├─ tools/               # Node CLI 数据导入/转换/打包工具
├─ deploy/              # 构建、启动、环境配置模板
└─ docs/                # 需求、架构、来源审计与验收文档
```

所有代码按项目根目录定位 `corpus/`、`wiki/`、`skills/`。`storage/` 是运行时状态，和只读知识资料分开；更新发布包时须保留它。不得把开发机 `F:`、`E:` 绝对路径写入运行代码、数据库引用或发布包内 Wiki 链接。Windows 开发产出的 `node_modules` 不直接复制给 Linux 服务器；服务器构建或容器构建须用锁文件重新安装依赖。

## 3. 请求与回答流程

```text
浏览器 → 鉴权 → 保存用户消息 → 识别问题类型与缺失输入
                                  ↓
                  Wiki 索引/来源页 + 已有会话上下文
                                  ↓
                  必要时调用本地排盘工具
                                  ↓
                  LLM 适配器 → SSE 增量返回浏览器
                                  ↓
                  核对引用/盘面 → 保存最终回复、出处及用量
```

会话恢复时按需取历史消息，不把全部聊天记录每次送给模型。应设置上下文预算，并保留用户问题、相关来源与必要的原盘数据。Wiki 和第三方 Skill 文本均按外部资料处理：它们可以提供知识与方法候选，不能覆盖服务端的安全、工具调用或回答格式约束。

### 流式协议

- `POST /api/conversations/{id}/messages`：JSON 请求体包含文本、可选六次爻值及选定模型；响应类型 `text/event-stream`。
- 事件至少有 `start`（消息 ID）、`delta`（增量文本）、`sources`（所用来源和定位）、`done`（最终状态/用量）、`error`（可展示的错误码）。单个事件的数据为 JSON；服务端不得把 API Key 或内部提示词写入事件。
- 用户停止生成时浏览器中止请求；服务端停止上游调用，并将回复标为 `interrupted`。上游故障标为 `failed`，完成标为 `completed`。恢复历史时显示这些状态。
- 代理或负载均衡不得缓存或缓冲该响应；反向代理需允许流式传输。Next.js 自托管文档明确要求检查 nginx 等代理的响应缓冲。[Next.js 自托管说明](https://nextjs.org/docs/app/guides/self-hosting)

WebSocket 在首版没有必要；当前交互是用户提交一条消息、服务器单向流式回传。历史读取、重命名等操作是普通请求。

普通 HTTP 完整响应也能完成聊天，所以 SSE 不是聊天功能本身的硬性前提；本项目把逐步显示列为首版体验要求，因此选用 SSE 格式。若目标服务器的代理无法透传流，开发方须先修正代理配置，再提交验收。

### 普通 API

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/conversations` | 按更新时间列出本人会话 |
| `POST /api/conversations` | 新建会话 |
| `GET /api/conversations/{id}` | 读取会话元数据 |
| `GET /api/conversations/{id}/messages` | 分页读取历史消息 |
| `PATCH /api/conversations/{id}` | 从当前聊天页或历史列表重命名同一会话标题；两处同步展示 |
| `POST /api/conversations/{id}/messages` | 提交问题并流式接收回复 |
| `GET /api/sources/{sourceId}` | 通过来源 ID 查看允许展示的出处；禁止任意路径参数直接访问磁盘 |

所有会话接口先验证登录状态和资源归属。跨站请求保护、同源 Cookie 策略、输入长度限制、服务端超时和错误信息脱敏属于首版交付要求。

首版只设一个拥有者账户。密码仅保存经过加盐的强哈希；登录态使用有期限的 `HttpOnly`、`SameSite` Cookie，在 HTTPS 下启用 `Secure`。密钥和密码不进入 Git、浏览器代码或发布包。若服务器仅经受控私有网络访问，也要保持会话接口的身份检查，避免同机其他访问者看到私人咨询记录。

## 4. 数据模型

| 数据 | 最少字段或内容 |
| --- | --- |
| `conversations` | ID、标题、标题来源（自动/手动）、创建时间、更新时间 |
| `messages` | ID、会话 ID、角色、内容、状态、创建时间、完成时间、模型和服务商、提示版本、错误码 |
| `message_sources` | AI 消息 ID、来源 ID、当时的 Wiki/原件定位、引用片段摘要、资料版本或哈希 |
| `chart_runs` | 关联消息 ID、输入、时区/时间口径、排盘规则版本、结构化盘面快照 |
| `model_usage` | 关联消息 ID、服务商、模型、输入/输出 token 数或 API 返回的等价用量、耗时 |

用户消息先入库；生成过程不持有长事务。AI 回复结束时保存最终状态、文本、来源和盘面快照。历史回答以当时快照呈现，不能因 Wiki 后续修改而悄悄改变。数据库文件存于 `storage/`，备份要采用数据库安全备份机制；部署文档须说明恢复步骤。

## 5. Skill 与四个外部仓库

**需要下载的是最终采用的 Skill 源码快照，不需要把四个仓库都“安装”到全局 Agent 目录。**开发方在排盘阶段获取固定提交版本，审查许可证、依赖、输入输出与代码行为；经选用的文件及许可放进项目 `skills/`，由 TypeScript 适配器显式调用。第三方 LLM API 不会自动发现磁盘上的 `SKILL.md`。

| 仓库 | 处理决定 |
| --- | --- |
| [`fortune-liuyao-skill`](https://github.com/shubhaviatiningsih-byte/fortune-liuyao-skill/blob/main/scripts/liuyao_core.py) | 真正的 Skill 候选；Python 核心实现六爻值校验、本变卦、八宫世应、纳甲、六亲、六神、旬空等确定性盘面字段。作为独立排盘对照和规则来源候选；若生产直接调用，发布包须含 Python 运行时 |
| [`liuyao-skills`](https://github.com/songgoldenwind-crypto/liuyao-skills/tree/main/liuyao-paipan-code) | 真正的 Skill 候选；有 JavaScript `buildLiuyaoDetail()` 排盘接口，可在提供日/月历法字段时生成盘面；从公历时间自动得农历、干支和节气的部分由 Node 调用 Python。优先评估其 JavaScript 核心在本项目的复用价值；历法模块单独选型与核对，保留两套 Skill 的方法边界和 MIT 许可 |
| [`woaichiji/liuyao`](https://github.com/woaichiji/liuyao) | 术语与主题参考，不是可执行 Skill；核对出处后才可编入 Wiki |
| [`divination-liuyao`](https://github.com/SmallTeddyGames/divination-liuyao) | 网页交互参考，不是本项目的排盘 Skill；其现有技术和卦辞叙事方式不等同于纳甲六爻规则 |

当前只做设计与评估，**尚未下载或执行这些仓库**。不能因有 Skill 文件就省略本项目的工具接口、权限边界和计算核对。

这里的“算法”至少分为起卦与爻值换算、历法换算、确定性排盘、按规则生成候选证据，以及最终断事解释。前四类有可执行代码或可形式化规则；最终结论仍依赖方法选择与解释，不能把软件计算正确当成预测已被证实。开发方先以第二个仓库的 JavaScript 排盘核心为优先候选，再用第一个仓库做相同输入的独立对照；公历到干支/节气的 Node 实现须单独评估日界、时区和节气边界。若无法可靠满足首版需求，再提交需要 Python 辅助运行时的架构变更供复核。

## 6. 数据处理、权限与发布

- 资料导入由 Node CLI 管理文件登记、哈希、相对路径、质量状态和 Markdown 输出。旧 DOC 转换与扫描 PDF 的 OCR 可以调用 LibreOffice、Tesseract 等专用工具，或对少量疑难页使用视觉 API；这些是**离线构建依赖**，不要求生产问答进程运行 Python。
- 同一私有发布包包含程序、原件副本、提取/清洗文本、图片、Wiki 和已采用 Skill。原件不提供公开下载端点。单用户网页登录或受控私有网络访问；公开互联网访问时使用 HTTPS 和反向代理。
- API Key 通过服务器环境变量提供。每次调用只传送必要资料片段；持久化日志避免记录完整私人问题、密钥和原始图片内容。
- 第一版按单实例设计。若以后多用户共享、横向扩容或使用独立数据库服务器，再评估 PostgreSQL 和对象存储；这不是当前开发前置条件。
