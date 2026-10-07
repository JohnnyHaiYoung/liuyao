# 第四阶段验收证据索引（供产品/架构方核对）

基线：**`942ded3`**（第四阶段共 37 个提交，`87aff84` 集成设计先行 → `942ded3`）。（注：`docs/phase4_acceptance_942ded3_2026-10-07.md` 的签收结论未被验收方采纳，第四阶段状态待复验。）
（本文件此前写的 `09b3a79` 是更早的提交，按复核意见 `docs/phase4_evidence_review_1a2e78f_2026-10-07.md` 更正。）
本文件由研发整理，**不是验收结论**；结论请由独立验收方在核对下列证据后自行给出。

## 0. 一条命令跑完全部离线证据

```powershell
cd E:\workspace-ai\xuanxue\liuyao\app
npm run check:all -- --with-http
```

> 不要用 `npm run a && npm run b`：Windows PowerShell 5.1 不支持 `&&`，会一条都不执行。
> `check:all` 由 Node 顺序调用各检查并汇总，跨 shell 一致。

**验收方于 2026-10-07 自行执行的实测结果：10/10 项通过**（下列各项取自该次运行的原始输出）：

| 检查 | 结果 |
| --- | --- |
| wiki 目录一致性（10 页哈希） | 通过：目录一致，条目与哈希均与 `wiki/` 当前内容匹配 |
| wiki 选页与证据片段 | 17/17 |
| 来源读取与出处接口安全 | 28/28 |
| 排盘适配（与阶段 3 CLI 逐字段一致） | 32/32 |
| 编排层（意图/引用/上下文/注入边界） | 51/51（含知识问法反例 4 条 + 歧义澄清 1 条） |
| 排盘副本一致性 | 11/11 |
| 旧库迁移与快照读写 | 30/30 |
| 端到端（假模型，四条主流程） | 48/48（含知识问法经消息接口确认不作本地缺项追问） |
| 千问适配器（本地模拟上游） | 22/22 |
| 阶段 1 HTTP 运行态回归 | 8/8（内含阶段 1 既有验收 37/37） |
| 浏览器级验收（Playwright + 本机 Chrome） | 2/2（依据随消息、切会话不残留、切换模型立刻发送） |

补充：`npm run typecheck` 退出码 0；`npm run build` 退出码 0；`node tools/corpus-cli.ts verify` → 通过 108 项 / 警告 0 / 失败 0。

## 1. 任务书第 7 节逐项 → 证据位置（验收方本次输出中的对应行）

| 第 7 节 | 证据（脚本 → 实际断言输出） |
| --- | --- |
| 1 通用问题无本地命中仍可答并标注 | `check:e2e` 场景 6：「不产生 sources 事件」「仍正常完成对话」「无候选时最终引用为空」；`check:wiki` 场景 3：「不编造本地来源」「给出无本地依据的警告」 |
| 1 概念问题命中概念页 | `check:wiki` 场景 1：「命中概念页 concepts/yongshen.md」；`check:orchestration`：「概念问题选中概念页并给出理由」 |
| 1 来源比较并列不裁决 | `check:e2e` 场景 2：「出处并列两个不同原件（并列而非裁决）」；`check:wiki` 场景 2：「并列打开被引来源页」 |
| 2 `needs_review` 带质量提示与原页图 | `check:wiki` 场景 1：「needs_review 质量被提示（不当作已核对）」；`check:source-reader` 第 4 节页图白名单 10 项 |
| 2 假引用不成出处 | `check:orchestration`：「未知编号 S99 被拦下」「磁盘路径与外部 URL 被记录但不生成链接」「不可引用片段即使被提到也不成出处」 |
| 2 回到 `source_id + ¶NNNN/页码` | `check:source-reader` 第 5 节：「出处三要素齐备：src-e6fc8612e955 / ¶0002 / 第 1 页 / corpus/cleaned/…md」「页图可从出处定位」 |
| 3 静卦/多动爻/老阴老阳 | `check:chart` 第 1 节：三例「与 CLI canonical 完全一致」（山水蒙 宫离 世4应1；山天大畜 宫艮 世2应5；地风升 宫震 世4应1） |
| 3 非法值与冲突（10 类） | `check:chart` 第 3/4 节：`invalid_line_value`/`invalid_day_ganzhi`/`invalid_month_branch`/`unsupported_timezone`/`invalid_date`/`out_of_range`/`conflicting_calendar_mode`/`invalid_day_boundary` 等逐项列出 |
| 3 缺项只追问必要输入 | `check:chart` 第 3 节：「缺项逐项精确（castTime + timezone，而不是笼统的 calendar）」；`check:e2e` 场景 5 八条起卦问法 → `model=local-clarification`、无盘、无候选、无上游 |
| 3 不静默使用发送时间/服务器时区 | `check:chart` 第 6 节：「未写时区 → missing 含 timezone（不默认服务器时区）」 |
| 3 手动日月/节气边界/范围 | `check:chart` 第 3/6 节：「手动历法只给一半 → 不排盘」「超出支持范围」；`paipan` 侧节气交接用例 |
| 4 旧盘追问沿用、不重算 | `check:e2e` 场景 4：「chart 事件 action=follow_up 且沿用同一 id」「未产生新盘（chart_runs 行数不变）：1 → 1」 |
| 4 新输入新建盘 + 哈希稳定 | `check:chart` 第 5 节：「同输入两次哈希相同」「不同输入哈希不同」；`check:e2e` 场景 3：「done.chartRunId 指向新盘且哈希一致」 |
| 4 资料更新后旧摘录仍可核对 | `check:e2e` 场景 7：「历史来源快照带当时的摘录与页哈希（P1-4）：S1:hash=73e4903a」 |
| 5 千问已配置可选 / 未配置不影响默认 | `check:qwen`：「未配置密钥时 listModels() 为空（不可被选择）」「配置密钥后列出 qwen3.7-plus」「默认提供方仍是 DeepSeek / 默认模型仍是 deepseek-flash」 |
| 5 流式终止/错误/用量分别解析 | `check:qwen`：「缺少 [DONE] → failed（保留已生成文本）」「缺少 finish_reason → failed」「流中途错误事件 → failed」「用量从上游 usage 解析」「浏览器断开 → interrupted」 |
| 5 切换模型不动旧记录 + 历史记 provider/model | `check:e2e` 场景 7：「显式请求的模型被如实使用并写入历史：model=fake-stream-v1」；`check:migration` 第 3 节历史 GET 字段 |
| 6 旧库副本迁移不丢历史 | `check:migration-phase4`：第 0/1/4 节「旧消息一行未少、内容未变：消息 4 → 4」「旧字段逐行未变」「正式库文件未被本脚本改动：db=97e8d54f8a72…」 |
| 6 无 `F:`/`E:` 依赖与密钥不外泄 | `check:vendor`：副本只依赖 `node:*`、相对路径与 `lunar-typescript`；构建产物检查（`.next` 内无 DB/图片/资料正文，密钥**值**零命中） |
| 第 8.4 节 假模型/模拟上游端到端证据 | `check:e2e`（`LIUYAO_FAKE_MODEL=1`，44/44）、`check:qwen`（本地模拟上游，22/22）、`check:phase1-regression`（真实 `next start` + 假模型，8/8） |
| 第 8.4 节 真实 API 联调 | `docs/phase4_delivery.md` 第 10 节：`check:provider-live` 6/6、`check:provider-real` 13/13（2026-10-07；由研发执行，非验收方亲测） |

## 2. 四类结论必须分开（避免混为一谈）

| 类别 | 本阶段能证明的 | 不能证明的 |
| --- | --- | --- |
| **程序校验** | 迁移、快照、意图判定、引用映射、来源接口安全、事件契约、缺项语义等**软件行为**（上表全部） | — |
| **与上游一致** | 排盘结果与阶段 3 自研 CLI 的 canonical **逐字段一致**（三例）；盘面字段来自服务端模块 | 与商业排盘软件、其他流派实现一致 |
| **来源观点** | Wiki 片段可回到 `source_id + ¶NNNN/页码`；`needs_review` 标注质量；比较题并列不裁决 | 任何流派观点的正确性；用神选取的权威口径 |
| **现实预测** | 无 | 吉凶/应期准确率、任何现实决策建议的有效性 |

## 3. 本次证据**未覆盖**的部分（如实列出）

1. **浏览器级页面行为：已补齐（2026-10-07，提交 `d393b44`）**。`npm run check:ui`（Playwright + 复用本机 Chrome）在**隔离空库 + 模拟上游**上覆盖两条要求：①依据绑定各自消息、新建会话不残留、回旧会话从历史快照恢复；②输入问题后切换模型**立刻发送**时，请求体的 `model` 与新模型一致，且模拟上游确实收到该模型调用（反向证明未打真实 API）。实测 `2 passed`，并经一键入口 `check:all --with-http --with-ui` 复跑（11/11、退出码 0）。**边界**：它不覆盖真实 API 联调、视觉/样式与移动端布局——浏览器自动化是回归防线，不替代功能修复。
2. **真实上游调用的验收方亲测**：验收方为控费未重发付费请求；研发记录见交付说明第 10 节。可用 `npm run check:all -- --with-live` 自行复跑（需 `app/.env.local` 配密钥）。
3. **生产构建的 20 条动态文件追踪提示**：已配置 `outputFileTracingExcludes` 且产物内无隐私文件，但未声称告警消失；standalone 发布包留待阶段 5。
4. **前端"非强制六爻值输入区"**：产品需求 §2 写"可附"、任务书 §2 写"可加"；服务端契约已具备（并经二次校验），页面暂无该控件（交付说明第 12 节第 9 项）。
5. **范围外**：用神权威口径、吉凶/应期算法、真太阳时（属带来源标签的解释，非本阶段软件正确性）。
6. **正式库未被测试触碰**：4 条消息 / 2 个会话 / 1 个迁移；所有测试跑在 `storage/tmp/` 副本上并自行清理。

## 4. 复现与核对入口

```powershell
cd E:\workspace-ai\xuanxue\liuyao\app
npm run check:all -- --with-http        # 全部离线证据 + 阶段 1 HTTP 回归（本次 10/10）
npm run check:all -- --with-http --with-ui   # 再加浏览器级验收（需先 npm run build；本次 11/11）
npm run check:all                       # 不含阶段 1 HTTP 回归
npm run check:all -- --with-live        # 附真实上游联调（需密钥、极小费用）
```

交付说明与设计：`docs/phase4_delivery.md`（含第 7/8/9/9.5/9.6/9.7/10/12/13 节）、`docs/phase4_integration_design.md`。
