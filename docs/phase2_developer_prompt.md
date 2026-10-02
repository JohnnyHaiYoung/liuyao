# 可直接交给开发 AI 的第二阶段提示词

将以下内容作为开发任务发送给负责写代码和整理资料的 AI。工作区为 `E:\workspace-ai\xuanxue\liuyao`。

---

你是本项目的研发 AI。请完成**第二阶段：小样本资料库与可追溯 Wiki**。开始前查看项目目录、Git 状态和已有未提交改动，保留第一阶段聊天网站及现有 Wiki 试点。

按顺序阅读：

1. `docs/phase2_development_spec.md`：本阶段范围、来源契约、质量门槛和验收场景；
2. `docs/development_plan.md`、`docs/product_requirements.md`、`docs/technical_architecture.md`：整体阶段及架构边界；
3. `wiki/schema.md`、`wiki/index.md`、`wiki/sources/src-08862b06aea9.md`：现有编写规则与试点；
4. `docs/corpus_audit.md`、`docs/source_inventory.csv`、`docs/pilot_source_assessment.md`：已有盘点，不把文件名判断当作正文事实。

请从 `F:\道教\六爻` **只读复制**至少 6 份不同哈希的代表性资料，覆盖 TXT、DOCX、旧 DOC、有文字层 PDF、扫描 PDF；按任务书完成包内原件、提取文本、清洗 Markdown、必要图片、`corpus/manifest.jsonl`、逐份质量报告及有出处的 Wiki 来源/概念/对照页面。先抽查候选内容，若不适合则换同类型文件并说明理由。对可控的 TXT/DOCX/DOC 处理全文；PDF 可选连续页段，但在所有索引和质量记录中明确范围，未处理页不得当作已收录。

用 Node.js/TypeScript CLI 管理导入、哈希、登记和校验；旧 DOC/PDF/OCR 可调用独立离线工具，并记录工具版本与重跑方法。处理仅针对项目内副本。不要调用付费云 OCR 或上传整本书；不要把机器提取结果直接升格为已核准规则。每条 Wiki 主张都要能从来源 ID 和定位回到项目内原件，保留不同体系或来源的分歧及不确定性。

本阶段不修改聊天模型流程、不接入 Wiki 阅读器、不做排盘、不安装第三方 Skill、不加入 embedding/RAG。不要修改 `F:` 原件，不在运行时代码或 Wiki 链接中依赖开发机绝对路径；不要把 API Key、聊天数据库或 OCR 临时缓存打包。若格式工具缺失，先完成可独立推进的格式与登记，并明确说明具体缺口，不以空文本冒充成功。

完成时提交任务书第 9 节列出的全部交付物，并给出实际样本清单、各来源质量状态与覆盖页段、已验证的原件追溯链、图片及相对链接检查结果、可重跑命令、资料包清单、未完成或有疑点的项目。请逐项对应第 9 节验收场景提供可复核证据。产品/架构方会独立验收，不以“程序运行成功”代替来源和内容核对。

---
