# 可直接交给开发 AI 的第一阶段提示词

将以下内容作为开发任务发送给负责写代码的 AI。它应在项目工作区 `E:\workspace-ai\xuanxue\liuyao` 执行。

---

你是本项目的研发 AI。请实现**第一阶段：可持久保存的自由聊天网站**，只在 `E:\workspace-ai\xuanxue\liuyao` 项目内工作。先查看现有目录及未提交改动，保留已有资料和文档。

开始编码前，按顺序阅读：

1. `docs/phase1_development_spec.md`：本阶段的详细任务与接口契约；
2. `docs/product_requirements.md`：用户可见行为；
3. `docs/technical_architecture.md`：Node.js、SSE、SQLite、权限及部署约束；
4. `docs/development_plan.md`：阶段边界；
5. `docs/acceptance_checklist.md`：后续整体验收标准。

上述文件是当前实现依据。`docs/implementation_plan.md` 和 `docs/agent_design_v0.md` 是早期草案，其中 Python/FastAPI 架构已被替换。发现文档冲突时，以第一阶段任务书和最新用户要求为准，并在交付说明中列出冲突与处理理由；不要悄悄改写产品需求。

本阶段请交付一个可运行的 Node.js/TypeScript + Next.js 网站：单用户登录、自由聊天页面、DeepSeek 官方 `deepseek-flash` 流式回复、停止生成、历史会话列表、继续已有聊天，以及**当前聊天页顶部和历史列表两处均可重命名同一会话标题并同步显示**，数据由 SQLite 持久化。浏览器通过 `fetch()` 向 `POST` 聊天接口发送问题，读取服务端规范化的 SSE 事件。保存完成、失败、中断状态；刷新页面或重启服务后历史仍可查看。实现安全的密钥处理、数据库迁移和备份恢复说明。

先按任务书完成数据库与身份、会话 API，再实现模型流和页面。保持模型适配层边界，方便后续接入千问、Wiki 与排盘。本阶段仅接 DeepSeek；Wiki、资料清洗和排盘后续实施。页面与模型回答不得声称已经读完资料或算出了尚未实现的卦盘。不要安装 PostgreSQL，不要把第三方 Skill 安装进全局目录，也不要修改 `F:\道教\六爻` 原件。

API Key 和密码只能从服务器环境配置读取，不能写进代码、浏览器包、数据库或提交内容。若当前没有真实 DeepSeek Key，完成可运行结构与清楚的环境配置说明，向用户说明联调仍需配置密钥；不要编造成功的 API 调用结果。

完成时提交：代码与依赖锁文件、数据库迁移、环境变量模板、启动步骤、接口和 SSE 事件示例、备份恢复步骤、已完成的需求清单、尚未完成或受环境限制的项目、关键技术取舍及其原因。请按 `docs/phase1_development_spec.md` 最后的验收场景给出可复核的操作步骤和实际结果。产品/架构方随后会依据文档验收。

---
