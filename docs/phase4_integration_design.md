# 第四阶段集成设计（先设计后编码）

版本：2026-10-06。依据：[第四阶段研发任务书](phase4_development_spec.md)、[产品需求](product_requirements.md)、[技术架构](technical_architecture.md)、[研发计划](development_plan.md)、[第三阶段最终验收](phase3_final_acceptance_a27e672_2026-10-05.md)。**本文件先提交，随后按其编码。**

## 0. 现状核对（按真实代码，不按旧文档）

| 层 | 真实接口（已核对） |
| --- | --- |
| 聊天/SSE | `POST /api/conversations/{id}/messages`（`app/src/app/api/conversations/[id]/messages/route.ts`）；`app/src/server/chat/stream-service.ts`；SSE 辅助 `app/src/server/http/sse.ts`；共享 DTO `app/src/shared/types.ts`（`MessageStatus = streaming/completed/interrupted/failed`、`ConversationSummary`、`MessageDto`、`UsageDto`） |
| 模型适配 | `app/src/server/llm/types.ts` 已定义 `LlmProvider` 边界：`LlmStreamResult{status,usedModel,usage,errorCode,errorDetail,finishReason}` + `onDelta` 回调；现有 `deepseek.ts` 与离线 `fake.ts`，选择逻辑在 `llm/index.ts` |
| 存储 | `app/migrations/0001_init.sql`：`owners`、`sessions`、`conversations`、`messages`（+ 索引）；迁移运行器 `app/src/server/db/index.ts`：`schema_migrations` 表、`MIGRATION_FILE_PATTERN=/^(\d{4})_[A-Za-z0-9_.-]+\.sql$/`、`applyMigrations()` |
| Wiki | `wiki/index.md`（导航）、`wiki/schema.md`（写作规范）、`wiki/concepts/yongshen.md`、`wiki/comparisons/meihua-vs-liuyao.md`、`wiki/sources/src-*.md`（6 份）、`wiki/log.md` |
| 排盘 | `paipan/bin/paipan.ts`（CLI）、`paipan/src/core.ts`（`buildChart`/`canonicalize`）、`paipan/src/calendar.ts`（`fromMoment`/`fromManual`/`PaipanError`）、`paipan/rules/rule-profile.v1.json`（`liuyao-rule-profile.v1`）；生产仅 `lunar-typescript@1.8.6`，Node ≥ 22.18 |
| 来源资料 | `corpus/manifest.jsonl`（6 源）、`corpus/cleaned/*.md`（含 `¶NNNN` 锚点）、`corpus/figures/src-*/page-*.md` 与页图、`corpus/reports/spotcheck/*.json`（质量状态） |

**结论：阶段 3 的排盘与阶段 2 的资料均以文件/JSON 形式存在，可直接被服务端读取；阶段 1 的 SSE 与消息状态机可扩展而不重写。**

## 1. 目录导航

1. 新增 `wiki/catalog.json`（版本化、机器可读）：
   ```json
   {
     "catalogVersion": "wiki-catalog.v1",
     "generatedFrom": { "indexPath": "wiki/index.md", "indexSha256": "…", "generatedAt": "…" },
     "pageCount": 9,
     "pages": [{
       "pageId": "concept:yongshen",
       "path": "wiki/concepts/yongshen.md",
       "kind": "concept|comparison|source",
       "title": "用神",
       "topics": ["用神", "取用神"],
       "aliases": ["用神是什么"],
       "methodLabels": ["六爻断卦"],
       "sourceIds": ["src-3f8243c07930"],
       "qualityStatus": "usable|needs_review",
       "applicableQuestions": ["概念解释", "取用原则"],
       "sha256": "…"
     }]
   }
   ```
2. 由 `app/scripts/build-wiki-catalog.mjs` 从 `wiki/index.md` + 各页 front-matter/正文链接**生成**并校验；`--check` 模式在条目/哈希不一致时非零退出（CI 与验收可跑）。
3. 运行时选页只用：标题/主题/别名精确与子串匹配 + `wiki/index.md` 显式链接 + 同页 `sourceIds` 扩展。**不遍历全部原件、不用 embedding/向量检索、不读全量清洗文本。**
4. 预算：默认最多 4 页、正文合计 ≤ 16,000 字符（`WIKI_MAX_PAGES`、`WIKI_MAX_CHARS` 可配）；超限时回执中标注 `budgetExceeded` 并提示用户缩小问题。每次记录选中页、页哈希与截取范围。

## 2. 请求/事件契约

**请求**（`POST /api/conversations/{id}/messages` 保持兼容，新增可选字段）：

```ts
interface SendMessageRequest {
  content: string;                       // 自由文本（不变）
  modelId?: ModelId;                     // 不变
  chartInput?: {                         // 新增、可选、非强制
    lineValues: number[];                // 6 个 6/7/8/9，初爻在前
    mode: 'auto_calendar' | 'manual_calendar';
    castAt?: string; timezone?: string; dayBoundary?: 'zi23' | 'midnight';
    dayGanzhi?: string; monthBranch?: string;
  } | null;
  chartAction?: 'auto' | 'new' | 'follow_up';   // 缺省 auto
}
```

**SSE 事件**（`start` 保持兼容；新增两个可选事件，顺序固定）：

```text
start        { messageId, conversationId, model, promptVersion }
sources      { sources: SourceRef[] }     // 服务端已验证；无命中则省略
chart        { chartRunId, summary, canonicalHash }   // 无盘/沿用/新建在这里区分
delta        { text }                     // 仅模型文本（不变）
done         { usage, status, finishReason, sourceIds, chartRunId }   // 与历史 GET 返回同一快照
error        { code, message }            // 状态 failed
```

- `SourceRef = { sid:'S1', sourceId, pagePath, locator:{type:'paragraph'|'page', value}, qualityStatus, excerpt, sha256 }`。
- 客户端**只**按服务端保存的 `sourceIds`/`chartRunId` 渲染；`delta` 文本里的任何 `S99`、路径、URL 不生成链接。
- 历史 `GET /api/conversations/{id}/messages` 的 `MessageDto` 增加可选 `sources` 与 `chart` 快照字段；旧消息为 `null`（阶段 1 行为不变）。

## 3. SQLite 迁移（`app/migrations/0002_phase4_wiki_chart.sql`）

不改 `0001_init.sql` 语义、不清空旧库；沿用 `schema_migrations` 机制。

```sql
CREATE TABLE IF NOT EXISTS chart_runs (
  id TEXT PRIMARY KEY,                       -- chart_run_id
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by_message_id TEXT,                -- 首次生成它的助手消息
  source_input TEXT NOT NULL,                -- 用户原文或结构化输入原样
  line_values TEXT NOT NULL,                 -- JSON: [8,7,8,8,8,7]（初爻在前）
  mode TEXT NOT NULL,                        -- auto_calendar | manual_calendar
  cast_at TEXT, timezone TEXT, day_boundary TEXT,
  day_ganzhi TEXT, month_branch TEXT,
  calendar_source TEXT,                      -- 服务端记录（自动/手动）
  rule_profile_version TEXT NOT NULL,        -- liuyao-rule-profile.v1
  core_version TEXT NOT NULL,                -- paipan-core/0.1.0
  canonical_hash TEXT NOT NULL,              -- sha256(canonicalize(chart))
  chart_json TEXT NOT NULL,                  -- 完整结构化盘面（canonical）
  error_code TEXT,                           -- 校验失败时非空，chart_json 为空
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chart_runs_conversation ON chart_runs (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS message_sources (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sid TEXT NOT NULL,                         -- S1/S2…（仅本次回答内有效）
  source_id TEXT NOT NULL,
  page_path TEXT NOT NULL,                   -- wiki 相对路径
  locator_type TEXT NOT NULL, locator_value TEXT NOT NULL,   -- paragraph:¶NNNN / page:N
  quality_status TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  page_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_sources_message ON message_sources (message_id);

ALTER TABLE conversations ADD COLUMN current_chart_run_id TEXT;   -- 会话当前盘引用（可空）
ALTER TABLE messages ADD COLUMN chart_run_id TEXT;                -- 每条助手消息绑定当时的盘
```

- 迁移幂等：`ALTER TABLE ... ADD COLUMN` 用 `PRAGMA table_info` 预检查，重复运行不报错。
- 写入顺序：先落用户消息与助手占位 → 生成盘/选页 → 模型流式（**不持有写事务**）→ 收尾时在一个短事务里写 `chart_runs`（若新建）、`message_sources`、消息状态与用量。
- 旧库：`chart_runs`/`message_sources` 为空，旧消息读出 `sources=null`、`chart=null`，`content/status/title/model` 不变。

## 4. 盘面与来源快照

- **盘面**：服务端 `app/src/server/chart/service.ts`
  - 新建：校验输入（复用 `paipan/src/calendar.ts` 的 `fromMoment`/`fromManual` 与 `core.buildChart`）→ `canonicalize()` → `canonical_hash = sha256(JSON.stringify(canonical))` → 写 `chart_runs`。
  - 沿用：`chartAction='follow_up'` 时只读 `messages.chart_run_id` 指向的快照，**不重算**（不读当前时间）。
  - 绑定：每条助手消息保存 `chart_run_id`；会话级 `current_chart_run_id` 只作提示，不覆盖历史。
  - 歧义：同时出现新爻值与追问语气、或时间/时区/爻序含糊 → 不排盘，返回 `missingInputs` 澄清（本地逻辑，无需模型）。
- **来源**：`app/src/server/wiki/service.ts`
  - 选页 → 读取页内 `source_id + ¶NNNN/页码` 定位 → 生成 `S1..Sn`（含质量、摘录、页哈希）。
  - 引用校验：`app/src/server/chat/citations.ts` 只接受本次 `selectedSids` 中的编号；未映射编号被丢弃并在收尾事件里记 `unmappedCitations`。
  - 快照：`message_sources` 保存当时的摘录、定位、质量与页哈希；即使 Wiki 之后被修改，历史仍显示当时版本。
- **安全边界**：`GET /api/sources/{sourceId}?locator=…` 需登录；只接受 `corpus/manifest.jsonl` 与 `wiki/catalog.json` 白名单内的 ID 与页路径；拒绝 `..`、绝对路径、符号链接越界、未知 ID；页图只经服务端生成的受控 asset ID（`/api/assets/{sourceId}/{page}`）返回。Wiki/Skill 文本按**数据**处理：其中任何"忽略此前指令/调用工具"字样都不改变选页、权限、预算与盘面 JSON。

## 5. 失败语义

| 情形 | 落库 | SSE | 历史回看 |
| --- | --- | --- | --- |
| 缺项（爻值/时间/时区不全） | 用户消息 + 助手消息（`completed`，正文为澄清） | `start` → `delta`(澄清) → `done`（无 `chart`） | 显示澄清与"未生成盘" |
| 排盘校验失败（非法爻值/日柱/超范围） | 助手消息 `completed`，正文含 `errorCode`，`chart_runs.error_code` 非空 | 同常规；`chart` 事件可选携带 `error` | 仍显示失败原因，不显示盘 |
| 模型流中断 | 已有文本保留，`status='interrupted'` | `done` 前触发 `error` 或直接 `done{status:'interrupted'}` | 保留文本、来源与盘状态 |
| 上游错误 | `status='failed'`，`errorCode` 安全码 | `error` | 同上；不覆盖旧用量 |
| 停止生成 | 复用阶段 1 停止按钮与 `in-flight` 机制 | `done{status:'interrupted'}` | 同上 |

- 模型调用期间不开启写事务；收尾写入使用单条短事务。
- 用量：成功/中断分别记录，失败不覆盖既有 `usage`。

## 6. 模型适配

- 默认 DeepSeek 官方 `deepseek-flash`（现状不变）；新增 `app/src/server/llm/qwen.ts` 适配阿里云百炼 `qwen3.7-plus`。
- 选择规则：`QWEN_API_KEY`（或 `DASHSCOPE_API_KEY`）存在且适配器自检可用时，`/api/models` 才列出千问；否则仅 DeepSeek。**未配置千问不影响默认模型。**
- 各适配器自行解析：流式增量、`[DONE]`/`finish_reason` 终止、错误体、用量字段；不共用终止判断。
- 每次回答记录 `provider`/`model`/`promptVersion`/`usage`；模型切换不改 Wiki 引用、历史引用或旧盘。
- 提示版本：`PHASE4_SYSTEM_PROMPT_VERSION`（替换阶段 1 的 `phase1-v1`），明确区分系统规则、用户问题、只读 Wiki 片段（编号证据）与不可改写的盘面 JSON，并保留"末段以『最终结果：』开头"。

## 7. 验收与自检脚本（离线可复跑）

| 脚本 | 覆盖 |
| --- | --- |
| `app/scripts/check-wiki-catalog.mjs` | 目录版本/哈希/条目与 `wiki/index.md` 一致；`--check` 非零退出 |
| `app/scripts/check-wiki-select.mjs` | 选页预算、命中正确概念页、无命中不伪造来源 |
| `app/scripts/check-source-endpoint.mjs` | 鉴权、白名单、`..`/绝对路径/未知 ID 拒绝、页图路径受控 |
| `app/scripts/check-citations.mjs` | 只接受本次 `Sx`；`S99`/路径/URL 不成为出处 |
| `app/scripts/check-chart-service.mjs` | 与阶段 3 CLI `--canonical` 逐字段一致；非法输入/缺项不生成盘 |
| `app/scripts/check-chart-followup.mjs` | 旧盘追问不重算；新输入新建；重启后沿用同一快照 |
| `app/scripts/check-migration-phase4.mjs` | 用阶段 1 旧库副本迁移；消息/状态/标题/模型不变；新表可用 |
| `app/scripts/check-phase4-e2e.mjs` | 假上游端到端：概念、来源比较、具体卦例、旧卦追问；SSE 顺序与历史一致 |
| `app/scripts/check-prompt-injection.mjs` | 隔离恶意 Wiki 样例（放 `storage/tmp`，不改正式资料）不能改变权限/选页/盘面 |
| `app/scripts/verify-phase1.mjs`（既有） | 阶段 1 回归：登录、SSE、停止、分页、两处重命名 |

## 8. 本阶段不做什么

不扩充资料、不微调、不引入 embedding/RAG 服务、不实现吉凶/应期权威算法、不做阶段 5 的发布包与备份恢复验收、不重写阶段 1 聊天与阶段 3 排盘核心。现实占断命中率不作为验收标准。

## 10. 接入 `stream-service` 的落地清单（2026-10-06 按真实代码核对，含行锚点）

以下行号基于提交 `0604284` 时的 `app/src/server/chat/stream-service.ts`（355 行）与
`app/src/app/api/conversations/[id]/messages/route.ts`（101 行）；实施时以当前文件为准。

| 步骤 | 位置 | 具体改动 |
| --- | --- | --- |
| 1 | `stream-service.ts:128`、`:231` | `promptVersion: PROMPT_VERSION` → `PHASE4_PROMPT_VERSION`（`prompt.ts` 已导出 `phase4-v1`） |
| 2 | `stream-service.ts:154-160` | 在取 `history` 之后、构造 `llmMessages` 之前调用 `planTurn({question: params.content, projectRoot, catalog, chartInput, currentChartRunId, promptVersion})`；用 `buildTurnContext()` 产出 `systemPrompt`，替换 `buildSystemPrompt()` |
| 3 | `stream-service.ts:160` | `llmMessages = [{role:'system', content: turnContext.systemPrompt}, ...history]`；**注意 history 已包含刚保存的用户消息**，不要再重复追加问题 |
| 4 | 本地澄清分支 | 若 `plan.missingInputs.length > 0 \|\| plan.ambiguities.length > 0`：**不调用模型**，用 `buildMissingInputReply(plan)` 作为助手正文，按 `start → delta → done`（`status: 'completed'`，无 `sources`/`chart`）落库并结束 |
| 5 | `stream-service.ts:225-233`（`send('start', …)` 之后） | 新增 `sources` 事件（`{sources: SourceRef[]}`，仅可引用片段）与 `chart` 事件（`{chartRunId, summary, canonicalHash, action}`）；顺序固定 `start → sources → chart → delta*  → done` |
| 6 | `stream-service.ts:235-252`（调用 provider 前后） | 新建盘面时先 `insertChartRun()`（在**短事务**里，不在模型流期间），把 `chartRunId` 记入局部变量；沿用旧盘时只读 `getCurrentChartRun()` / `getChartRunForMessage()`，**不重算** |
| 7 | `stream-service.ts:280-295`（`finalizeAssistantMessage` 之后） | 短事务写入：`bindMessageChart({messageId, chartRunId, planJson: JSON.stringify(plan), promptVersion})`、`insertMessageSources(db, messageId, validateCitations(assistantText, wiki.snippets).citations)`；失败/中断时也保存 plan 与已生成的来源，但不得伪造完成态 |
| 8 | `stream-service.ts:297-321` | `SseDoneData` 增加 `sourceIds` 与 `chartRunId`；`error` 分支保留盘面与来源状态（不伪装完成） |
| 9 | `shared/types.ts:157` | `SseEventName` 增加 `'sources' \| 'chart'`；新增 `SseSourcesData`/`SseChartData`，`SseDoneData` 增加可选 `sourceIds`/`chartRunId`；`MessageDto` 增加可选 `sources`/`chart` 快照（旧消息为 `null`） |
| 10 | `lib/api-client.ts:175-177`、`:227-237` | 增加 `onSources`/`onChart` 回调与 `case 'sources'`/`case 'chart'` 分支；未识别事件保持向后兼容 |
| 11 | `components/ChatApp.tsx` | 渲染服务端给出的盘面摘要与可点击出处（只用服务端 `citations`，不解析模型文本里的 Sx/路径）；"展开依据"显示来源、质量与计算口径 |
| 12 | `route.ts:71-92` | `ChatRequest` 透传可选 `chartInput` 与 `chartAction`（校验：爻值只接受 6/7/8/9，时区走白名单；越权/非法一律 400） |

**验收脚本**（下一步实现）：
- `app/scripts/check-phase4-e2e.mjs`：假上游 + 真实 Next 服务，覆盖四条主流程（概念 / 来源比较 / 具体卦例 / 旧卦追问）、SSE 事件顺序、历史 GET 与 `done` 一致、缺项澄清不调用模型、S99 不成链接。
- 阶段 1 回归：`npm run verify:phase1`（需运行中的服务 + 验收密码）——登录、SSE、停止生成、分页、两处重命名。
- `next build` 必须真正打包 `liuyao-paipan`（届时以构建产物中出现该包为证）。

## 11. 第三阶段两处非阻断勘误（本阶段一并修正）

1. **卦宫是否自动比较**：`paipan/scripts/upstream-compare.mjs` 当前只打印三方卦宫 → 增加**机器比较**（我方 `chart.palace.name` vs JS `palace.name` vs Python `palace`），差异计入非零退出；并把 `docs/phase3_delivery.md` 第 3 节表述改为与实现一致。
2. **旧迁移验证文字**：`docs/phase3_delivery.md` 第 7 节仍残留"2026-10-04 实际结果/随包 `node_modules`"的旧叙述 → 替换为当前"新目录按锁文件 `npm ci --omit=dev` 重装"的真实记录。
