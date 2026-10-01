# 资料处理实施草案（早期）

状态：2026-10-01；保留早期资料处理分析供参考，尚未开始批量导入或转换。本文后半部分的 Python/FastAPI 服务方案已被用户的 Node.js/TypeScript 决策取代，**不得作为当前开发架构执行**。当前实现依据 [产品需求](product_requirements.md)、[技术架构](technical_architecture.md) 和 [研发计划](development_plan.md)。格式盘点、出处追踪与质量风险仍可参考本文件；具体转换工具由开发方按 Node 主服务及试点效果重新选定。

## 产品目标与边界

- 个人使用；对六爻概念、来源观点、方法差异及具体卦例自由提问。
- 默认简明分析；用户要求时展开出处与排盘过程；每次把「最终结果」放在末尾。
- 资料中的主张按来源保存，允许多个体系并列；不由 Agent 擅自决定某书或某 Skill 是唯一权威。
- F 盘原件在导入时保持只读；把原件副本复制到项目的 `corpus/originals/`，再从项目内的副本提取和清洗。服务器运行时不能依赖 F 盘或任何开发机绝对路径。
- Wiki 页面与清洗文本分开：前者是跨来源整理，后者是可回溯的资料副本。资料准备完成前，不承诺 Agent 已能回答全部六爻问题。

## 目录布局

```text
liuyao/
├─ app/              # Agent 服务、API 适配层、Wiki 阅读器和排盘工具接口
├─ corpus/
│  ├─ originals/     # 从 F 盘导入的原始文件副本，供部署后核对出处
│  ├─ extracted/     # 尽量保留原貌的机器提取文本，标明页/段
│  ├─ cleaned/       # 统一 UTF-8 Markdown，去除可识别的网页杂质等
│  ├─ assets/        # Markdown 引用的卦象、表格和必要的页面图片
│  ├─ reports/       # 转换异常、抽查记录、OCR 质量报告
│  └─ manifest.jsonl # 未来由处理程序生成：相对路径、哈希、处理方法、状态
├─ wiki/             # 按来源、概念、方法和争议整理的知识页；已有试点
├─ skills/           # 经审查和适配的本地 Skill 及其版本、许可记录
├─ deploy/           # 发布包清单、启动配置与打包脚本
├─ tools/            # 可重复运行的盘点、转换与质量检查脚本
└─ docs/             # 设计、资料盘点、实施计划和决策记录
```

运行时路径都从项目根目录解析。例如 `corpus/manifest.jsonl` 中记录 `corpus/originals/...` 和 `corpus/cleaned/...` 的相对路径；F 盘路径只作导入历史记录。发布包必须包含 `app/`、`corpus/originals/`、`corpus/extracted/`、`corpus/cleaned/`、`corpus/assets/`、`corpus/manifest.jsonl`、`wiki/`、`skills/` 及运行配置模板。Git 忽略大体积生成文件是版本管理选择，**打包程序仍须显式把它们包含进去**；仅克隆 Git 仓库不是完整部署包。首轮不让清洗程序修改 Wiki，需在核对来源后再编入知识页。

## 资料处理流水线

1. **导入**：从 F 盘复制到 `corpus/originals/`，保留相对目录结构并核对 SHA-256；记录最初的 F 盘路径，但后续处理只读项目内副本。
2. **登记**：沿用 [source_inventory.csv](source_inventory.csv) 的文件类型和 SHA-256。完全相同的文件只转换一次，其他路径记为别名；同名但哈希不同的文件按不同版本处理。
3. **提取**：按实际文件签名分流。每页或每段保留定位标记、转换方法和错误信息；不能读取的文件保留失败记录。
4. **清洗**：统一 UTF-8、换行和标题；清除可确认的导航、广告、水印重复行。卦象、图表与影响断义的版面图片保存到 `assets/`，在 Markdown 中用相对路径引用并注明原页码；无法确定是否为正文的内容不自动删除，标记人工复核。
5. **质量检查**：检查空文本、乱码、页数/段落缺失、重复、异常短页、OCR 可疑字符；抽看开头、中间和结尾。质量状态为 `usable`、`needs_review` 或 `failed`，不以文件可打开代替内容正确。
6. **编入 Wiki**：先建来源页，再将有定位依据的概念、规则、案例和分歧写入 Wiki；标记来源主张、跨来源核对与争议。Wiki 索引和维护记录同步更新。

未来 `manifest.jsonl` 每条至少记录 `source_id`、项目内原件相对路径（含重复别名）、导入来源记录、完整 SHA-256、实际格式、提取器和版本、OCR/编码方式、项目内输出相对路径、页/段定位方式、质量状态及人工处理备注。现有试点来源 ID 使用哈希前缀；实现时检测前缀冲突并保留完整哈希。

## 格式与技术选择

| 输入 | 首选办法 | 重点风险和后续处理 |
| --- | --- | --- |
| TXT（25 份） | Python 读取字节，尝试 UTF-8 / GB18030；必要时用 `charset-normalizer` 提示候选编码，模糊结果人工确认 | 两份编码抽样待复核；不能以自动检测结果当作事实 |
| DOCX（2 份） | `python-docx` 读取段落和表格，保存顺序与结构信息 | 图片、文本框或复杂版式需抽查 |
| 可提取文字的 PDF | `pdfplumber` 逐页提取，保留原 PDF 页码 | 文字层可能只有水印，阅读顺序也可能错乱 |
| 扫描或混合 PDF | 先逐页判别文字层；需要时以 `pypdfium2` 渲染页面，再用 Tesseract 简繁中文 OCR 试点 | 抽样有 38 份 PDF 在三个抽样页未提取出文字，不能据此认定全书每页都要 OCR；卦象、表格与竖排文字需人工复核 |
| 旧版 DOC（64 份，含一份实际为 RTF） | 后续使用 LibreOffice 命令行转换，再按文本或 DOCX 处理 | 先选少量文件验证格式保真；另有一份扩展名为 DOC 但签名异常，单独检查 |
| PPT / RAR（各 1 份） | PPT 后续用 `python-pptx`；RAR 先查看内容清单再决定是否展开 | 非首轮核心，不让压缩包内容自动进入 Wiki |

这里的 `pdfplumber`、`python-docx`、`python-pptx` 和 PDF 渲染库在当前 Codex 工作区附带的 Python 环境可用；**自建 Agent 不能依赖 Codex 内置运行时**，正式开发时要创建独立、可复现的 Python 环境。当前系统的 `python` 是 3.11.0rc2 且没有 `pip`；常见安装位置及 PATH 未发现 LibreOffice/Tesseract，所以 DOC 批量转换和 OCR 尚需准备工具。OCR 先比较少量复杂页的效果，再决定是否引入更重的方案。

参考：[pdfplumber 的逐页提取说明](https://github.com/jsvine/pdfplumber/blob/stable/README.md)、[pypdfium2 渲染说明](https://github.com/pypdfium2-team/pypdfium2)、[python-docx 文档](https://python-docx.readthedocs.io/en/latest/index.html)、[LibreOffice 命令行转换参数](https://help.libreoffice.org/latest/en-GB/text/shared/guide/start_parameters.html)、[Tesseract 的简繁中文语言数据](https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions.html)。这些是候选工具的官方资料，尚未对本资料库完成实际效果评估。

## Agent 技术结构

| 模块 | 首版选择 |
| --- | --- |
| 主程序 | Python 服务；首版提供对话 API 与同服务的极简网页聊天入口（候选框架 FastAPI），命令行仅用于开发和管理 |
| LLM 接口 | 单独的 API 适配层；默认 DeepSeek 官方 API 的 `deepseek-flash`，复杂问题可配置切换到阿里云百炼 `qwen3.7-plus`。API Key 使用服务器环境变量，不写进发布包或 Wiki |
| 知识读取 | 读取 `wiki/index.md`，按标题、主题链接和页面元数据打开相关 Markdown；需要图像推理时解析相对图片路径并读取文件，不建向量库 |
| 排盘 | 与解读分开的确定性工具；对现有两个六爻 Skill 的程序部分做同输入对照后选用或重写 |
| Skill | 登记本地 Skill 路径和调用契约，按需要读取说明/运行脚本；不假设安装后 API 会自动发现 |
| 记录 | 服务器保存输入、所用来源页、排盘口径、模型与提示版本；私人咨询记录单独存放，可关闭或清理，不混入发布包 |

首版避免引入多 Agent 框架和向量数据库。若 Wiki 目录变大，可先改善人工可读索引与交叉链接；需要更快的本地文字查询时再评估 SQLite 全文索引，但这不是首版依赖。

### API 最小配置

用户已确认使用 DeepSeek 官方 API。按[官方首次调用说明](https://api-docs.deepseek.com/quick_start/pricing-details-cny/)设置 `LLM_BASE_URL=https://api.deepseek.com`、`LLM_MODEL=deepseek-flash`，并在服务器环境中提供 `DEEPSEEK_API_KEY`。示例见项目根目录的 [`.env.example`](../.env.example)；其中不含真实密钥。第二模型使用阿里云百炼的 [`qwen3.7-plus`](https://help.aliyun.com/zh/model-studio/qwen3-7-plus)，在模型适配层中单独配置其 API 地址、模型名和服务器环境密钥。第二模型按需启用，无须在资料处理阶段购买或配置。

DeepSeek 当前[模型说明](https://api-docs.deepseek.com/quick_start/pricing/)列出 Flash 的工具调用、JSON 输出和图像输入能力，因此第一版只需一款生成模型。Wiki 的目录导航和页面读取由 Agent 程序完成，**不需要 embedding API、向量数据库或重排模型**。排盘工具在服务器本地执行。大量扫描页仍需要 OCR 处理；本计划先用本地工具试点，模型图像输入只作为疑难页的可选辅助手段，不把整批资料直接发送给 API。

Markdown 的 `![说明](../assets/来源ID/图片.png)` 仅是本地图片引用。Agent 调用 API 时需要显式读取文件，并将图片作为图像输入块随文字提交；只发送当前问题相关的图片。DeepSeek [图像输入文档](https://api-docs.deepseek.com/guides/vision/)确认 `deepseek-flash` 支持本地图片经 base64 提交，且图片也按 token 计费。纯文字可表达的表格或卦象应同时保留结构化文本，便于比较和校验；图片保留原貌供核查。

发布方式先保持中立：整个项目目录就是数据与程序的交付单元。若服务器支持容器，优先用单服务容器运行 Python API，并从同一发布目录读取资料；否则按服务器系统准备独立 Python 运行环境。FastAPI 的[官方容器部署说明](https://fastapi.tiangolo.com/deployment/docker/)可作为实现参考。无论如何，发布包都要经过脱离 F 盘的完整性检查。

## 分阶段交付

| 阶段 | 产物 | 完成判据 |
| --- | --- | --- |
| 0. 目录与规则（本次） | `app/`、`corpus/`、`wiki/`、`skills/`、`deploy/` 的约定和本计划 | 开发与部署目录一致，运行时无 F 盘依赖 |
| 1. 小样本导入与转换 | 可重复运行的导入/转换程序；至少覆盖 TXT、DOCX、文字 PDF 的代表性文件 | 原件副本、`extracted/`、`cleaned/`、图片 `assets/`、manifest 和质量报告都在项目内，出处可回到项目内原件 |
| 2. DOC 与 OCR | 少量旧版 DOC 和扫描 PDF 试点，再分批扩大 | 记录失败与需复核页；不因自动转换成功就编入规则 |
| 3. Wiki 扩展 | 来源页、术语页、方法边界与争议页 | 每个进入问答的规则都能定位来源，冲突并列展示 |
| 4. Agent 原型 | 可配置第三方 API 的服务，接 Wiki 阅读和排盘工具 | 能回答概念问题、比较来源、处理完整卦例；默认短答且最后给最终结果 |
| 5. 服务器发布包 | 可重复生成的单目录发布包，含原件、清洗文本、Wiki、Skill、程序和配置模板 | 在不连接 F 盘的环境中能启动、读取资料并定位来源；发布包内无 API Key |
| 6. 可选微调 | 在积累经核对的问答样例后决策 | 只针对已观察到的稳定问题评估收益，不把原书直接当作完整训练集 |

## 当前决策与待定项

- 已定：项目自包含发布、运行时无 F 盘依赖、原件与清洗文本在同一包、按目录读取 Wiki、无向量 RAG、个人使用、简明分析和末尾最终结果。
- 已定：第一版默认使用 DeepSeek 官方 API 的 `deepseek-flash`；复杂问题可以按需切换阿里云百炼 `qwen3.7-plus`。不接 embedding API。模型适配层保持可配置。
- 待定：服务器系统及是否可运行容器、OCR 工具在中文扫描件上的效果、排盘 Skill 的接口和时间口径、是否需要独立用户界面。前两阶段的资料处理不依赖这些选型。
- 主要成本：扫描件 OCR 与人工校对最耗时；后续 Wiki 编写和 API 调用也有费用。现在没有足够依据给出准确工时或金额。
