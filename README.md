# 个人六爻 Agent

目标：构建可整体打包部署到服务器的个人六爻 Agent 网站，采用 Node.js/TypeScript，接入可配置的第三方 LLM API，以项目内的 LLM Wiki 和排盘工具支持自由聊天、历史记录、概念问答、资料比较及具体卦例分析。默认简明分析，依据按需展开，最终结果放在回答末尾。

当前处于需求、架构与资料试点阶段。产品/架构方只负责研发文档和后续验收；具体开发由用户指定的其他 AI 完成。项目已有资料目录和部署约定，尚未批量导入、转换、安装外部 Skill 或实现排盘程序。

**第一阶段（可持久保存的自由聊天网站）已实现**：`app/` 下为 Node.js/TypeScript + Next.js 的可运行站点，
包含单用户登录、自由聊天、DeepSeek Flash 流式回复、停止生成、历史会话与标题重命名、SQLite 持久化与备份脚本。
当前仅接入 DeepSeek，**Wiki 阅读与排盘尚未接入**，页面与回答不会声称已读资料或已算出卦盘。
启动步骤、接口与 SSE 示例、备份恢复、验收实测记录见 [第一阶段交付说明](docs/phase1_delivery.md)。

- [产品需求](docs/product_requirements.md)
- [技术架构](docs/technical_architecture.md)
- [研发计划与阶段验收](docs/development_plan.md)
- [第一阶段研发任务书](docs/phase1_development_spec.md)
- [第一阶段交付说明（实现、接口、SSE、备份恢复、验收实测）](docs/phase1_delivery.md)
- [第一阶段独立验收记录（2026-10-02）](docs/phase1_acceptance_2026-10-02.md)
- [第一阶段开发 AI 提示词](docs/phase1_developer_prompt.md)
- [首版验收清单](docs/acceptance_checklist.md)
- [开发 AI 交接说明](docs/developer_handoff.md)
- [Agent 设计草案（早期）](docs/agent_design_v0.md)
- [资料处理实施草案（早期）](docs/implementation_plan.md)
- [本地资料盘点](docs/corpus_audit.md)
- [外部仓库评估](docs/external_repositories.md)
- [资料处理目录](corpus/README.md)
- [发布包约定](deploy/README.md)
- [API 配置示例](.env.example)
- [Wiki 索引](wiki/index.md)
- [Wiki 编写规则](wiki/schema.md)
