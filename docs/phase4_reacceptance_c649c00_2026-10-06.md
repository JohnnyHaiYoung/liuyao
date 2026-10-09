# 第四阶段复验报告（2026-10-06）

基线：`HEAD c649c00`，对照 `docs/phase4_development_spec.md` 及上次报告 `docs/phase4_acceptance_7467a4b_2026-10-06.md`。本次仅独立检查和记录，未修改产品代码。仓库仍有此前文档的未提交改动；本次检查涉及的 `app/` 代码已提交。

## 结论

**未通过第四阶段最终验收。** 上次的构建、排盘输入透传、历史快照接口、千问适配与旧盘 `chart` 事件均已有修复；但缺项意图、最终引用呈现、历史回看页面和模型选择仍有可复现的问题。模块自检通过不能覆盖这些用户流程缺口。

## 通过的检查

| 命令 | 本次结果 |
| --- | --- |
| `cd app; npm run build` | 退出码 0；仍有 20 条 Turbopack 动态文件追踪警告，交付方已列为阶段 5 待核查 |
| `cd app; npm run typecheck` | 退出码 0 |
| `cd app; npm run check:wiki` | 目录一致；选页 17/17，来源读取 28/28 |
| `cd app; npm run check:chart` | 32/32 |
| `cd app; npm run check:orchestration` | 35/35 |
| `cd app; npm run check:vendor` | 排盘源码副本逐字节比对 11/11 |
| `cd app; npm run check:qwen` | 本地模拟上游 21/21；未使用真实千问密钥 |
| `cd app; npm run check:migration-phase4` | 旧库副本迁移及快照读写 30/30；正式库哈希未变 |
| `cd app; npm run check:e2e` | 服务端假模型 30/30，含新盘和旧盘追问；正式库未改 |
| `cd app; npm run check:phase1-regression` | HTTP 回归 8/8，内含阶段 1 的 37/37 |

以上是**已运行的离线/本地结果**。没有真实 DeepSeek/千问 API 联调；交付说明已披露。

## 待修复问题

### P1-1 单纯请求起卦仍绕过缺项询问

在真实目录上直接调用 `planTurn`：

| 输入 | 当前 `intent` | `missingInputs` | 本地澄清 |
| --- | --- | --- | --- |
| `帮我起卦` | `source_comparison` | `[]` | `null` |
| `另起一卦` | `general` | `[]` | `null` |
| `请帮我看卦` | `general` | `[]` | `null` |

代码位于 `app/src/server/chat/planner.ts:73-128`：只在已提取到爻值/历法等输入时调用排盘缺项检查；起卦意图本身未触发。于是这些提问会进入模型回答，不能保证按任务书先询问六爻、起卦时间和时区。现有端到端脚本只测了**已提供爻值、缺时间**的情况，未覆盖本问题。需增加起卦/新卦意图的缺项分支和上述原话的回归样例。

### P1-2 页面把“选中的候选资料”显示成“本次引用”，与历史不一致

`app/src/server/chat/stream-service.ts:198-212` 生成全部可引用候选，`:347-349` 在模型输出前就发 `sources`；真正的引用校验在 `:432-474` 才发生。`app/src/components/ChatApp.tsx:383-385` 立即把候选放入 `liveSources`，`:827-834` 把它们渲染为可点击“依据”。

本次 `check:e2e` 的概念题收到 `sources` 中 3 条候选；假模型正文没有任何 `Sx`，历史中**0 条来源快照**。脚本 `app/scripts/check-phase4-e2e.mjs` 最后的“历史来源快照”检查使用 `(sourcesMessage?.sources ?? []).every(...)`，空数组也返回真，所以显示“0 条”却判通过。`done` 与历史此时都为空，**页面却仍把 3 条候选显示为依据**，直接违反“只有被实际引用且通过映射的编号才能成为最终可点击出处”的要求。应把候选和最终引用明确分开；最终展示仅用 `done.sourceIds` 对候选过滤，或用完成后的历史快照，并修复端到端断言为非空且逐项一致。

### P1-3 盘面和依据与消息/会话脱离，历史回看会串错

`app/src/components/ChatApp.tsx:827-836` 在整个消息列表上**分别**寻找最后一个有盘的消息和最后一个有来源的消息，组成一个全局 `MessageEvidence`；它们可能属于不同回答。消息循环 `:838` 以下未在对应助手消息内渲染自己的快照。`openConversation`/`startNewChat` (`:270-305`) 也未清除 `liveChart/liveSources`，而二者只在下一次 SSE `onStart` 才清除 (`:369-371`)。因此切换到另一会话或空白新会话后，页面仍可能显示上个会话的盘面/依据。

数据库历史已正确存了每条消息的 `chart/sources`，修复应在**每条助手消息**旁展示其自身快照，流式状态按当前会话和消息 ID 绑定；切换/新建会话立即清除流式证据。加入“会话 A 有盘/出处 → 切到空白会话 B → 回 A 查看旧消息”的页面回归。

### P1-4 历史引用的旧摘录/版本没有交给页面

`message_sources` 已保存 `excerpt/page_sha256`，但 `app/src/server/db/messages.ts:239-253` 映射到历史 DTO 时只返回 `sid/sourceId/定位/质量/href/label`；`SseSourceRefData` 也没有摘录与哈希字段。`MessageEvidence` 的链接仍指向**当前** `/api/sources/{id}?locator=…` 内容。Wiki 或清洗文本变更后，用户只能看到当前页，无法从网页核对当时回答所依据的旧摘录或识别版本变化。任务书要求“历史存当时引用文本、定位、质量与哈希快照；旧回答与引用不因资料更新变化”。需把已存快照的摘录/哈希返回并展示，点击当前出处时显式区分当前版本与历史版本。

### P2-1 模型切换后立即发送可能仍调用旧模型

`app/src/components/ChatApp.tsx:366` 发送时使用 `selectedModel`，但 `handleSend` 的 `useCallback` 依赖列表 (`:435-446`) 未含 `selectedModel`。用户先输入问题、再切换模型、立刻点“发送”时，回调可能保留切换前模型值。需加入依赖并做“输入后切换模型再发送”的 UI/HTTP 断言，核对请求模型和历史消息 `model/provider`。

### P2-2 首屏说明仍称 Wiki 和排盘未接入

`app/src/components/ChatApp.tsx:788-799` 的空白会话文案仍写“只接通 DeepSeek Flash”“尚未接入项目 Wiki 资料与六爻排盘程序”“具体排盘尚不可用”，与第四阶段现状相反。应更新，避免用户据此误判能力。

## 复验门槛

修复上述 P1 后，用新增的**非预设问题**复验：纯起卦请求只澄清、不调用模型；有目录候选但模型未引用时最终依据为空；模型引用有效 `Sx` 后 `done`、历史和页面一致；两条回答及跨会话切换各显示自己的盘面和出处；Wiki 更新后历史仍能展示旧摘录/哈希；输入问题后再切换千问的实际请求与历史模型一致。最后重跑生产构建、现有自检与阶段 1 回归。
