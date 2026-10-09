# 个人六爻 Agent

目标：构建可整体打包部署到服务器的个人六爻 Agent 网站，采用 Node.js/TypeScript，接入可配置的第三方 LLM API，以项目内的 LLM Wiki 和排盘工具支持自由聊天、历史记录、概念问答、资料比较及具体卦例分析。默认简明分析，依据按需展开，最终结果放在回答末尾。

当前阶段 1–4 已通过独立验收，正在制定和实施阶段 5 的 Linux Docker 发布与部署。产品/架构方负责需求文档和独立验收；具体开发由用户指定的其他 AI 完成。首批六份资料与可追溯 Wiki 已接入聊天，本地确定性排盘也已接入；其余资料尚未批量导入。第四阶段签收依据见[最终验收报告](docs/phase4_final_acceptance_d6c5148_2026-10-09.md)。

**第一阶段（可持久保存的自由聊天网站）已实现**：`app/` 下为 Node.js/TypeScript + Next.js 的可运行站点，
包含单用户登录、自由聊天、DeepSeek Flash 流式回复、停止生成、历史会话与标题重命名、SQLite 持久化与备份脚本。
第四阶段在此基础上加入 Wiki 目录阅读、来源与盘面快照、排盘服务端适配以及可选千问模型。发布包和目标服务器尚未通过第五阶段验收。
启动步骤、接口与 SSE 示例、备份恢复、验收实测记录见 [第一阶段交付说明](docs/phase1_delivery.md)。

**第二阶段（小样本资料库与可追溯 Wiki）已实现**：`corpus/` 下为 6 份不同哈希的样本
（TXT×2、DOCX、旧 DOC、文字层 PDF、扫描 PDF）的包内原件、忠实提取文本、清洗 Markdown、原页图与逐份质量报告，
`corpus/manifest.jsonl` 记录哈希、处理方式与覆盖范围；`tools/corpus-cli.ts` 提供导入、提取、OCR、清洗、报告与校验命令
（零 npm 依赖；旧 DOC 与 PDF 使用自实现解析器，扫描件使用 Windows 内建离线 OCR）。
`wiki/` 下新增 6 个来源页、更新「取用神」概念页并新增「梅花易数起卦与六爻断卦的边界」对照页，每条主张都可按
来源 ID 与段落锚点回到包内原件。实测证据与未完成项见 [第二阶段交付说明](docs/phase2_delivery.md)。

**第三阶段**的本地排盘与**第四阶段**的聊天融合已签收。第五阶段要求把应用与首批资料组成可离线迁移的 Docker 包，并在隔离环境和目标服务器分别核验数据持久化、HTTPS/SSE、备份恢复与升级回滚；详见[第五阶段研发任务书](docs/phase5_development_spec.md)。

更多本地资料的录入已作为[Wiki 扩充第一批](docs/wiki_expansion_batch1_spec.md)与 Docker 发布并行启动；新增来源通过独立验收后再进入正式发布版本。

- [产品需求](docs/product_requirements.md)
- [技术架构](docs/technical_architecture.md)
- [研发计划与阶段验收](docs/development_plan.md)
- [第一阶段研发任务书](docs/phase1_development_spec.md)
- [第一阶段交付说明（实现、接口、SSE、备份恢复、验收实测）](docs/phase1_delivery.md)
- [第一阶段独立验收记录（2026-10-02）](docs/phase1_acceptance_2026-10-02.md)
- [第一阶段复验记录（2026-10-02）](docs/phase1_reacceptance_2026-10-02.md)
- [第一阶段开发 AI 提示词](docs/phase1_developer_prompt.md)
- [第二阶段研发任务书（范围、来源契约、质量门槛、验收场景）](docs/phase2_development_spec.md)
- [第二阶段交付说明（样本清单、追溯链、工具限制、验收证据）](docs/phase2_delivery.md)
- [第三阶段最终验收](docs/phase3_final_acceptance_a27e672_2026-10-05.md)
- [第四阶段独立最终验收](docs/phase4_final_acceptance_d6c5148_2026-10-09.md)
- [第五阶段研发任务书](docs/phase5_development_spec.md)
- [第五阶段开发 AI 提示词](docs/phase5_developer_prompt.md)
- [Wiki 扩充第一批研发任务书](docs/wiki_expansion_batch1_spec.md)
- [Wiki 扩充第一批开发 AI 提示词](docs/wiki_expansion_batch1_developer_prompt.md)
- [首版验收清单](docs/acceptance_checklist.md)
- [开发 AI 交接说明](docs/developer_handoff.md)
- [Agent 设计草案（早期）](docs/agent_design_v0.md)
- [资料处理实施草案（早期）](docs/implementation_plan.md)
- [本地资料盘点](docs/corpus_audit.md)
- [外部仓库评估](docs/external_repositories.md)
- [资料处理目录与重跑命令](corpus/README.md)
- [发布包约定](deploy/README.md)
- [API 配置示例](.env.example)
- [Wiki 索引](wiki/index.md)
- [Wiki 编写规则](wiki/schema.md)
