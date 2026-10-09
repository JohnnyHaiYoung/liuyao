# 可直接交给开发 AI 的第三阶段提示词

工作区：`E:\workspace-ai\xuanxue\liuyao`。

---

你是本项目的研发 AI。请完成**第三阶段：第三方 Skill 审查、历法口径与确定性排盘**。开始前检查 Git 状态和现有改动，不覆盖已验收的阶段 1 聊天与阶段 2 资料。按顺序阅读：

1. `docs/phase3_development_spec.md`（本阶段任务书与验收门槛）；
2. `docs/development_plan.md`、`docs/product_requirements.md`、`docs/technical_architecture.md`；
3. `docs/external_repositories.md`、`docs/phase2_reacceptance_18bcb3b_2026-10-04.md`、`wiki/schema.md`；
4. `skills/README.md` 和现有 `app/` 目录结构。

先获取 `songgoldenwind-crypto/liuyao-skills` 与 `shubhaviatiningsih-byte/fortune-liuyao-skill` 的固定完整提交快照，在隔离目录审查许可证、依赖、排盘输入输出、历法路径和代码行为，再决定复用范围。不要一键安装到用户全局 Skill 目录，也不要把四个仓库整包复制进生产项目。上游 README 和测试结果是候选证据，不是本项目验收结论。

优先研究前者的 JavaScript 排盘核心；它的公历换算由 Python 桥接，应单独评估。用后者 Python 核心做同输入对照，并记录不同的规则前提。首版以 Node.js/TypeScript 服务为目标：实现明确输入顺序的六次 `6/7/8/9` 爻值排盘、版本化规则口径、结构化 JSON 输出和无模型依赖的命令行入口；历法方案须单独选择并验证日界、时区和节气边界。缺少日柱/月建时，相关字段只能标不可用，不得使用看似真实的默认盘面。若 Node 历法方案不能达到要求，提交有证据的架构差异提案，不要静默引入 Python 生产依赖。

按任务书第 6 节提供可重跑样例与核对依据，区分“原书原页核对”“独立实现对照”“上游自测”和“尚未核实”。采用源码、许可证、版本、依赖与发布包保持一致；运行不得依赖开发机 `F:`、`E:` 路径。不要在本阶段调用 DeepSeek、修改聊天流程、接入 Wiki 阅读器或宣称占断现实准确性。

完成时提交任务书第 7 节全部产物，并逐项给出实际命令、输出、哈希、固定提交版本、日界/节气边界结果、差异表和已知限制。产品/架构方会从独立输入和迁移后的目录复验，不以“上游仓库测试通过”代替本项目验收。

---
