# 外部六爻仓库评估

评估更新：2026-10-01。此表登记用户提供的 GitHub 仓库及其适用位置。判断基于仓库公开页面、README、目录和部分 Skill 入口；仓库代码尚未下载或在本机运行，README 的测试结果尚未独立复核。产品运行方案已改为 Node.js/TypeScript，详见 [技术架构](technical_architecture.md)。

| 仓库 | 已看到的内容 | 在本项目中的位置 | 当前处理 |
| --- | --- | --- | --- |
| [woaichiji/liuyao](https://github.com/woaichiji/liuyao) | 按主题拆分的 Markdown 入门笔记，涵盖起卦、纳甲、六亲、世应及若干断卦术语 | 初学者术语与主题索引的参考 | 登记链接；需核对原始出处和文本质量后再引用规则。仓库首页未见许可证，不复制全文 |
| [shubhaviatiningsih-byte/fortune-liuyao-skill](https://github.com/shubhaviatiningsih-byte/fortune-liuyao-skill) | Apache-2.0 Skill；自述包含本地 Python 排盘、历法、事实检查、解释流程与 HTML 展示；源码运行要求 Python 3.10+ | 确定性排盘引擎候选、咨询流程候选 | 开发阶段下载固定提交版本用于审查和同输入对照；若生产直接使用，必须打包 Python 运行时；首版优先把选中能力实现为 TypeScript。其默认长报告和先给判断的格式需适配本项目要求 |
| [songgoldenwind-crypto/liuyao-skills](https://github.com/songgoldenwind-crypto/liuyao-skills) | MIT 仓库；两套分开的解读 Skill，另有 JavaScript 排盘核心；公历转历法上下文通过 Python 桥接 | 本项目 Node 排盘引擎的优先候选及方法对照参考 | 开发阶段下载固定提交版本，保留两个 Skill 的方法边界；审查 JavaScript 核心，另选或验证历法实现；仓库自述的测试覆盖还需独立复核 |
| [SmallTeddyGames/divination-liuyao](https://github.com/SmallTeddyGames/divination-liuyao) | Next.js 网页；README 描述自动起卦动画、卦象展示、按关键词评分选择问题类别及卦辞叙事解读 | 交互与卦象展示参考 | 与纳甲排盘和多体系规则库分开登记。仓库首页未见许可证，不复制代码、素材或长篇数据 |

## 关键边界

- 这些仓库属于**第三方整理或实现**。仓库名称、作者数量、星标和自述测试不能证明术数结论准确，也不能直接确定传统流派归属。
- `fortune-liuyao-skill` 与 `liuyao-skills` 都包含程序排盘能力，但运行依赖、时间口径和输出契约不同。比较时先固定六次爻值、起卦时间、时区和日界规则，再核对本卦、变卦、世应、纳甲、六亲、六神和旬空等字段。
- `divination-liuyao` 的 README 重点是卦辞、变爻和界面化解读。它应作为另一类解读方式或界面参考，不能仅凭仓库名认定为独立的纳甲六爻体系。
- 用户要求默认短答、按需展开、最后给最终结果。第三方 Skill 的输出模板不能直接覆盖这一要求。
- GitHub 官方说明：公开可见与开源授权是两件事。对未见许可证的仓库，先保留链接与评价；需要复制或改编内容时再核实授权。已标注 MIT、Apache-2.0 的仓库如需复用代码，应保留对应许可与归属信息。

## 整理方式

1. 将四个仓库作为独立外部来源保存 URL、访问日期、用途和许可状态。未来实际采用代码时固定具体提交版本。
2. 把“可确定计算的字段”“解读规则”“交互体验”分别提取为候选，不整包安装为唯一六爻规则。
3. 先针对两个排盘引擎做同输入对照，记录差异及规则口径。只把复核过的接口接进本项目。
4. 将有明确出处的解读规则映射到本地资料；无法溯源的条目标记为“第三方实现主张”，不冒充古籍原文。

## 是否需要下载到本地

研发进入排盘阶段时，开发方需下载**两套真正的 Skill 候选**到本项目的审查区，固定提交版本，核对许可证、依赖和输出；通过审查且实际采用的文件才进入 `skills/` 和最终发布包。用户不需要把它们安装进个人全局 Skill 目录。`woaichiji/liuyao` 是知识参考，`divination-liuyao` 是界面参考，均不作为首版可执行 Skill 安装。自建 Node Agent 要显式实现 Skill 发现、方法选择和受控工具调用，第三方 LLM API 不会自行读取本地 `SKILL.md`。

## 公开页面

- [woaichiji/liuyao 文件目录](https://github.com/woaichiji/liuyao)
- [fortune-liuyao-skill README](https://github.com/shubhaviatiningsih-byte/fortune-liuyao-skill) 与 [SKILL.md](https://github.com/shubhaviatiningsih-byte/fortune-liuyao-skill/blob/main/SKILL.md)
- [liuyao-skills README](https://github.com/songgoldenwind-crypto/liuyao-skills)、[两套 Skill](https://github.com/songgoldenwind-crypto/liuyao-skills/tree/main/skills) 与 [排盘模块](https://github.com/songgoldenwind-crypto/liuyao-skills/tree/main/liuyao-paipan-code)
- [divination-liuyao README](https://github.com/SmallTeddyGames/divination-liuyao)
- [GitHub 关于仓库许可证的说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
