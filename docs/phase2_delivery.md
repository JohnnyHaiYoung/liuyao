# 第二阶段交付说明：小样本资料库与可追溯 Wiki

版本：2026-10-02。实现依据：[第二阶段研发任务书](phase2_development_spec.md)、[产品需求](product_requirements.md)、[技术架构](technical_architecture.md)、[Wiki 编写规则](../wiki/schema.md)。

本阶段交付**离线资料与知识组织能力**：包内原件、忠实提取文本、清洗 Markdown、必要图片、`corpus/manifest.jsonl`、逐份质量报告，以及有出处的 Wiki 来源/概念/对照页面。**未接入聊天页面或 DeepSeek，未做排盘，未加入 RAG/embedding，未安装第三方 Skill**；阶段 1 的聊天功能保持可用且未改动其模型流程。

---

## 1. 样本清单（6 份不同哈希，覆盖 5 类格式）

| 角色 | 文件（相对 `F:\道教\六爻`） | `source_id` | 字节 | 覆盖范围 | 质量 |
| --- | --- | --- | ---: | --- | --- |
| TXT-1 | `五行所属行业\六爻取用神之辩证看法.txt` | `src-08862b06aea9` | 3,319 | 全文（14 段） | `usable` |
| TXT-2 | `《周易预测学》讲义..txt` | `src-25fcddea758b` | 100,448 | 全文（146 段） | `usable` |
| DOCX | `五行所属行业\六爻爻象详解.docx` | `src-946795472cd6` | 16,895 | 全文（122 段） | `usable` |
| 旧 DOC | `六爻用神答疑（51页）王虎应.top.doc` | `src-3f8243c07930` | 379,904 | 全文（285 段） | `usable` |
| 文字层 PDF | `邵伟华周易预测学(下)  ..pdf` | `src-e6fc8612e955` | 649,461 | **整本 23 页** | `usable`（文字层为 OCR 产物） |
| 扫描 PDF | `张成达八字六爻风水31册\11、张成达-六爻快速断卦法.pdf` | `src-f3f838d501b1` | 280,309 | **第 1–5 页（整本 5 页）** | `needs_review`（OCR 未逐字校对） |

- 6 份哈希互不相同；`src-08862b06aea9` 沿用 2026-09-30 试点的来源 ID（该 ID 规则为 `src-` + SHA-256 前 12 位，本次未发生碰撞，因此未扩位）。
- 候选更换记录：`tools/sample-set.json` 的 `deferred` 列出两份未采用的旧 DOC 及理由（样本量已够；`六爻中高级班讲课记录…doc` 的真实签名是 RTF，属格式异常样本，不占用旧 DOC 名额）。
- 选择依据均来自**正文抽查**（见 `corpus/reports/spotcheck/<source_id>.json` 与各质量报告第 1 节），不以文件名判断主题或作者。

## 2. 工具链、环境限制与重跑方法

本机（Windows 11 / Node v22.20.0）**没有** pip（PyPI 与国内镜像均不可达）、LibreOffice、antiword/catdoc、tesseract、poppler、7-Zip；Microsoft Word 16 已安装但 **Word COM 自动化在本沙箱内挂起**（已清理残留 WINWORD 进程，`tools/offline/word-convert.ps1` 保留但标注不可用）。

因此本阶段采用**零依赖**方案，并如实记录替代路径：

| 格式 | 实现 | 依赖 | 重跑命令 |
| --- | --- | --- | --- |
| TXT | `tools/lib/common.ts`（TextDecoder：utf-8 / gb18030 / big5 逐候选比较替换字符与控制字符） | Node 内置 | `node tools/corpus-cli.ts extract --all` |
| DOCX | `tools/lib/office.ts readDocx`（自实现 ZIP + OOXML：段落、表格、`word/media` 提取） | Node 内置 zlib | 同上 |
| 旧 DOC | `tools/lib/office.ts readLegacyDoc`（自实现 OLE2/CFB + FIB + 分片表 piece table；压缩片按 CP1252、非压缩片按 UTF-16LE 解码） | Node 内置 | 同上 |
| 文字层 PDF | `tools/lib/pdf.ts readPdf`（对象扫描 + Flate + 页面树 + 字体 ToUnicode CMap + 内容流 Tj/TJ 算子） | Node 内置 zlib | 同上 |
| 扫描 PDF | `tools/offline/pdf-render.ps1`（Windows.Data.Pdf 原生分辨率渲染）+ `tools/offline/ocr-image.ps1`（Windows.Media.Ocr，`zh-Hans-CN`，**离线**） | Windows 内建组件 | `node tools/corpus-cli.ts ocr --source src-f3f838d501b1 --pages 1-5` |
| 页面图资产 | `tools/offline/image-downscale.ps1`（System.Drawing → JPEG，宽 ≤1400，质量 82） | Windows 内建 | `node tools/corpus-cli.ts assets --source <id> --pages 1-2` |

- **未调用任何云 OCR/云服务**，未上传整本书；OCR 临时渲染图保存在 `storage/work/`（不进资料包）。
- OCR 语言可用性、`MaxImageDimension=10000` 与"渲染后再放大会超限"这类细节由 `ocr-image.ps1` 自动处理并在元数据中记录。
- `tools/` 只有 Node 内置依赖，因此**没有 npm 依赖锁文件**（`tools/package.json` 不存在）；CLI 以 `node tools/corpus-cli.ts <命令>` 直接运行（Node 22 原生执行 TypeScript）。

## 3. 资料包清单（交付时必须随包复制）

| 路径 | 文件数 | 字节 | 说明 |
| --- | ---: | ---: | --- |
| `corpus/originals/` | 6（+README） | 1,397 KB | 与 F 盘对应的原件副本，复制前后核对 SHA-256 |
| `corpus/extracted/` | 6（+README） | 356 KB | 忠实提取文本；页/段边界与疑点保留 |
| `corpus/cleaned/` | 6（+README） | 398 KB | UTF-8 Markdown，段落带 `<!-- ¶NNNN -->` 锚点 |
| `corpus/assets/` | 7（+README） | 2,417 KB | 原页图 JPEG：扫描件 5 页、文字层 PDF 第 1–2 页 |
| `corpus/reports/` | 6 报告 + 6 抽查 JSON（+README） | 37 KB | 逐份质量报告与人工抽查原始记录 |
| `corpus/manifest.jsonl` | 6 行 | 9,368 B | 机器可读登记 |
| `wiki/` | 10 个 Markdown | — | `index.md`、`log.md`、`schema.md`、6 个来源页、1 概念页、1 对照页 |
| `tools/` | 4 个 `.ts`/`.mjs` + 3 个 `.ps1` + `sample-set.json` | — | 可重复执行的导入/提取/清洗/报告/校验命令 |

**不入包**：`storage/`（聊天数据库、`storage/work/` OCR 临时图与渲染缓存）、`app/node_modules`、任何密钥。Git 忽略大文件不影响交付：发布/交接包须**显式**包含上表内容（`git clone` 结果不算资料交付）。

## 4. manifest 契约与真实样例

每行一个来源，字段语义见任务书第 4 节。真实样例（`corpus/manifest.jsonl` 第 1 行，节选）：

```json
{"source_id":"src-08862b06aea9",
 "sha256":"08862b06aea969661316c04da39e0bd45150dfd6969aeea4c44a9b529a2b792f",
 "sizeBytes":3319,"format":"txt","extension":".txt","discoveredAt":"2026-10-02T13:58:41.285Z",
 "sourceRelativePathFromF":"五行所属行业\\六爻取用神之辩证看法.txt",
 "originalRelativePath":"corpus/originals/五行所属行业/六爻取用神之辩证看法.txt",
 "aliasSourcePaths":[],"duplicateOf":null,"suspectedVersionRelation":null,
 "processing":{"status":"processed","inputEncoding":"gb18030",
   "extractor":"tools/lib/common.ts decodeTextBuffer (TextDecoder)","extractorVersion":"node v22.20.0",
   "ocrLanguage":null,"processedAt":"2026-10-02T14:09:28.142Z",
   "extractedPath":"corpus/extracted/src-08862b06aea9.txt",
   "cleanedPath":"corpus/cleaned/src-08862b06aea9.md","assetPaths":[],"tools":[]},
 "coverage":{"structureSummary":"纯文本；解码候选：gb18030(替换 0, 控制字符 0)；big5(替换 0, 控制字符 0)；utf-8(替换 1839, 控制字符 0)；置信度 high",
   "totalUnits":"14 段（按空行/换行切分）","processedUnits":"全文","unprocessedUnits":null,
   "quality":"usable","issues":[]},
 "notes":["角色：TXT-1；用途：…","提取统计：1715 字符 / 1414 汉字 / 14 段","清洗：段落 14 个，删除行 0","清洗说明：段落锚点：14 个（¶0001..¶0014）"]}
```

- 只有 `sourceRelativePathFromF` 保留 F 盘相对路径（审计历史）；所有运行时输出路径都是**项目相对路径**。
- 扫描件的 `processing.ocrLanguage`、`processing.tools`（含工具版本与重跑命令）与 `coverage.processedPages/unprocessedUnits` 会写明页段范围。

## 5. 逐份质量状态与覆盖页段（要点）

| 来源 | 已处理 | 未处理 | 主要疑点 |
| --- | --- | --- | --- |
| `src-08862b06aea9` | 全文 14 段 | — | 自称作者「道源」与转引古书版本未核实；「锁定用神」自述待验证 |
| `src-25fcddea758b` | 全文 146 段 | — | 自述摘自他人讲义（转载性质）；卦例以空格对齐，读爻位需对照原件 |
| `src-946795472cd6` | 全文 122 段 | — | 文件内**无图片、无表格**（已核对 ZIP 内无 `word/media`、无 `w:tbl`）；内容为象义条目，缺完整卦例 |
| `src-3f8243c07930` | 全文 285 段 | — | 作者身份未核实；含线上排盘系统残留与超链接域；排盘列对齐不可靠 |
| `src-e6fc8612e955` | 整本 23 页 | — | **文字层是 OCR 产物**：形近字（已/巳、戍/戌）、卦象以 `██` 方块表示；引用干支须核对原页图 |
| `src-f3f838d501b1` | 第 1–5 页（整本） | — | OCR 未逐字校对（第 1 页已目视逐行对照原页图，其余页抽查）；含现实人事断语 |

各报告还包含：入选理由、结构与处理范围、工具与版本、编码/OCR 情况、**人工目视抽查表**（位置/定位/发现）、清洗改动与后续建议。抽查由开发方完成并写明方式，**不写成"用户已审核"**；没有标注集，因此不虚报 OCR 准确率。

## 6. 追溯链：Wiki 主张 → 包内原件

链条固定为：`Wiki 主张 → source_id + locator → cleaned 段落 → extracted 对应位置 → originals 原件`。完整示例（来自对照页，扫描件 OCR 来源）：

1. Wiki：`wiki/comparisons/meihua-vs-liuyao.md` 中「该来源自述『初筮准，再筮错』」→ 定位 `src-f3f838d501b1` `¶0177`（第 5 页，起始语「准，再筮错」）。
2. cleaned：`corpus/cleaned/src-f3f838d501b1.md` 内 `## 第 5 页（PDF 实际页码）` 下的 `<!-- ¶0177 … -->` 段落。
3. extracted：`corpus/extracted/src-f3f838d501b1.txt` 的 `===== 扫描页（PDF 第 5 页）=====` 段。
4. originals：`corpus/originals/张成达八字六爻风水31册/11、张成达-六爻快速断卦法.pdf` 第 5 页；原页图 `corpus/assets/src-f3f838d501b1/page-005.jpg` 可直接目视核对。

第二条示例（文字层 PDF）：`wiki/concepts/yongshen.md` → `src-e6fc8612e955` `¶0184`（第 3 页「若用神不现」）→ `corpus/cleaned/src-e6fc8612e955.md` → `corpus/extracted/src-e6fc8612e955.txt` → `corpus/originals/邵伟华周易预测学(下)  ..pdf` 第 3 页。

**定位稳定性**：段落锚点 = `¶序号` + `stableId(source_id, 'paragraph', 序号, 段落前 24 字)`（SHA-256 前 12 位），同一原件重复转换时保持稳定；PDF 另有 **PDF 实际页码** 标题。

## 7. 图片与相对链接检查结果

- `node tools/corpus-cli.ts verify` 的图片检查：**7 项全部通过**（每张资产的包内相对路径都存在）。
- Wiki 中所有 Markdown 链接（含到 `corpus/cleaned/`、`corpus/originals/`、`corpus/assets/` 的链接）均解析成功，**0 条失效**；文件名含括号的链接使用 `<...>` 目标形式（`邵伟华周易预测学(下)  ..pdf`）。
- 链接目标全部是包内相对路径；页面中的 F 盘绝对路径仅出现在标注为「初次导入来源…（仅审计记录）」的行，校验器对此**只给警告、不判失败**，且当前为 0 警告（全部已标注）。

## 8. 第 9 节验收场景逐项证据

| # | 验收场景 | 证据 |
| --- | --- | --- |
| 1 | 从两条 Wiki 主张沿 `source_id` 和定位找到清洗文本、提取文本及项目内原件；一条来自 OCR/PDF | 见第 6 节两条完整链条（一条 OCR 扫描件、一条文字层 PDF）；`verify` 会核对每个 `¶NNNN` 锚点与其「起始语」是否真的出现在对应来源的清洗文本中（当前全部通过） |
| 2 | 核对 6 个不同哈希与 5 类格式覆盖；TXT/DOCX/DOC 全文或例外，PDF 已处理/未处理页段 | 第 1 节样本表；TXT/DOCX/DOC 均为全文；文字层 PDF 整本 23 页；扫描 PDF 第 1–5 页（整本），manifest 的 `coverage` 写明页段与未处理范围 |
| 3 | 随机比对复制原件与 F 盘 SHA-256；确认 F 盘原件未因处理而变化 | `verify` 输出 6 条：`F 盘原件与导入时一致（… mtime 2024-11-09T17:13:43Z）`；同时核对包内原件 SHA-256（6 条通过）。处理只读取 F 盘 |
| 4 | 查看一处图/表/爻位：Markdown 相对图片链接有效，文字记录与原页相符，模糊部分有标记 | 扫描件第 1 页：`corpus/assets/src-f3f838d501b1/page-001.jpg` 与 `¶0001–¶0025` 逐行对照记录（质量报告第 5 节）；文字层 PDF 第 2 页的 `██` 爻位问题在来源页与报告中明确标注为「文字层无法还原阴阳爻」 |
| 5 | 复跑导入不产生重复来源或覆盖人工 Wiki 内容；同哈希别名与近名不同哈希处理正确 | 复跑 `import` 后仍为 6 行（同哈希只登记一次）；`clean`/`report` 复跑前后 **wiki 全部 Markdown 的哈希一致**（证据：`wiki 哈希 before=754D75330E631620 after=754D75330E631620 一致=True`）；本批次无同哈希别名；`suspectedVersionRelation` 仅登记、不合并 |
| 6 | 模拟转换失败或低质 OCR：manifest/report 如实显示 `failed` / `needs_review`，不自动进入可用规则 | 扫描件标为 `needs_review`，其来源页与报告写明"OCR 未逐字校对"；文字层 PDF 标为 `usable` 但同时记录 OCR 形近字风险与 `██` 爻位问题；概念页不引用扫描件作为规则；`upstream`/提取失败路径由 CLI 抛出明确错误而不是写空文件（空提取会得到 `failed`，见 `commandExtract` 的异常处理） |
| 7 | 对照页：各观点能各自回到原文，方法差异与未核实点未被合成统一规则 | `wiki/comparisons/meihua-vs-liuyao.md`：两份来源相反立场各带 `source_id` + 锚点；明确写出"起卦环节 vs 断卦环节"的前提差异，并列出**不能据此推出的结论** |
| 8 | 复制完整项目资料到不带 F 盘路径的新目录，只用包内相对路径打开 Wiki 图片与出处并完成校验 | 见第 9 节"离线复核步骤"：把项目复制到任意目录后运行 `node tools/corpus-cli.ts verify --verbose`；`verify` 的链接/锚点/资产检查全部基于项目相对路径（F 盘不可访问时对应检查降级为警告，不影响其余结论） |

## 9. 离线复核步骤（无 F 盘也能跑）

```bash
# 1) 复制整个项目目录到任意位置（不含 storage/ 也可）
# 2) 在项目根执行：
node tools/corpus-cli.ts verify --verbose     # 哈希 / 链接 / 定位 / 资产 / manifest 结构
node tools/corpus-cli.ts status               # 6 份来源的覆盖与质量一览
```

F 盘不可访问时，`verify` 会把 6 条"F 盘原件一致"的检查降级为 `warn`（提示无法复核），其余 25 项仍给出结论。

## 10. 未完成 / 有疑点（如实列出）

1. **语义层面的人工核对是有限抽查**：共 6 份样本、约 5.2 万字提取文本，抽查覆盖每份的开头/中部/结尾或指定页段，**不是逐字校对**；`needs_review` 来源（扫描件）尤其如此。
2. **文字层 PDF 的可靠性受原件限制**：该 PDF 的文字层由 OCR 生成，形近字与 `██` 爻位无法通过后处理修复；引用干支、爻位前必须核对原页图。
3. **旧 DOC 的版式信息丢失**：自实现解析只取正文文本，不保留字体、表格边框或图片；该样本正文可读，但若后续需要版式（如卦象表格），应引入 LibreOffice 等工具重做。
4. **本阶段未做**：Wiki 阅读器接入、Agent 选页、排盘、第三方 Skill、embedding/RAG、PPT/RAR 转换、其余 133 份资料。
5. **未验证项**：OCR 准确率未量化（无标注集，不虚报百分比）；未在 Linux/服务器环境重跑（工具依赖为 Windows 内建组件，Linux 上需换 poppler/tesseract 或改用云外的方式，属后续部署阶段议题）。
6. **待核实的内容属性**：所有作者/版本/流派归属均来自文本自述（如"摘自邵伟华、邵伟中讲义"），**没有独立核实**；转引古书未定位版本。

## 11. 取舍与偏差说明

| 事项 | 处理与理由 |
| --- | --- |
| 无 pip / PyPI 不可达 | 不依赖第三方库，自实现 OLE2/DOC、OOXML、PDF（内容流 + ToUnicode）解析；代价是解码覆盖面有限（不支持 ZIP64、加密 PDF、JBIG2/JPX 图像），已在代码与本文档写明 |
| Word COM 挂起 | 放弃 COM 路线，改自实现 MS-DOC 解析；保留 `tools/offline/word-convert.ps1` 并标注"本环境不可用"，供有 LibreOffice/Word 的机器参考 |
| OCR 选择 Windows 内建引擎 | 本机无 tesseract 且不能安装；Windows OCR 为**离线**组件、支持 `zh-Hans-CN`，满足"不调用付费云 OCR、不上传整本书"的约束；代价是字形相近处仍需人工核对 |
| 扫描件 OCR 覆盖整本 5 页 | 任务书要求"至少 3 页"，该样本仅 5 页且是短篇，整本处理成本低、可核对性更好 |
| 页面图以 JPEG 入包 | 原生渲染 PNG 每页约 5 MB（5 页≈27 MB），改为宽 ≤1400、质量 82 的 JPEG（每页约 0.3–0.4 MB）；原件完整渲染留在 `storage/work/` 不入包 |
| 段落锚点用 HTML 注释 | 不干扰 Markdown 渲染，可被 `verify` 机械检查；PDF 同时给出实际页码标题 |
| 质量状态从严 | 只要存在影响释义的 OCR/归属/版式疑点就标 `needs_review`；`usable` 只表示"在声明范围内定位可靠"，不表示预测有效 |

## 12. 第二阶段独立验收记录阻断项修复（2026-10-02）

独立验收（[phase2_acceptance_2026-10-02.md](phase2_acceptance_2026-10-02.md)）判定"暂不通过"，列出 5 个 P1 与 4 项内容问题。逐项修复与复验证据如下。

| 项 | 修复 | 复验证据 |
| --- | --- | --- |
| P1-1 清洗文本来源链接失效 6/6 | 生成路径改为 `../../wiki/sources/<source_id>.md`；`verify` 的链接检查范围扩展到 `corpus/cleaned/`（先剔除代码块与行内代码，避免把文档示例当链接） | 见 `verify` 输出：`corpus/cleaned/*.md` 的相对链接全部通过 |
| P1-2 卦图/图文状态不符 | 文字层 PDF 生成**全部 23 页**原页图并随包；清洗文本按页嵌入 `![第 N 页原页图](../assets/...)`；含 `██` 的 **20 页**在页内标注"本页卦例不作为默认规则"；该来源质量由 `usable` 降为 `needs_review`（来源页、索引、概念页同步）；扫描件 5 页图同样按页嵌入 | `verify --verbose` 中 20 条 `含卦图/爻位占位字符，已嵌原页图并在页内标注` 全部通过；无原页图时该检查判 `fail` |
| P1-3 同哈希别名丢失 | `import` 在循环内实时更新哈希索引；同哈希的后续路径一律并入 `aliasSourcePaths`，主路径固定为首次导入路径；别名不再重复复制原件（哈希相同） | 隔离复验脚本 `tools/offline/accept-isolation-test.mjs`：同批（a→b）、分批（b 再来）、反向分批（a 先 b 后）**3/3 通过**，均为 `主路径=copy-a.txt 别名=["copy-b.txt"]` |
| P1-4 空提取误判 usable | 提取正文非空白字符 < 20 → `processing.status=failed`、`coverage.quality=failed`，写入原因与重试指引；`clean` 拒绝为 `failed` 来源生成清洗文件；`verify` 新增"状态与产物一致性"检查 | 隔离复验：零字节文件得到 `failed/failed`、无清洗文件、原因已记录（**1/1 通过**）；`verify` 对 6 个来源的正文非空检查全部通过 |
| P1-5 交接包不自包含 | 新增 `node tools/corpus-cli.ts pack [--out <zip>]`：零依赖 ZIP 写入器、固定时间戳（输入不变则归档字节一致）、包内 `PACK-MANIFEST.txt` 列出每个文件的 SHA-256 与字节数；同时生成 [phase2_pack_inventory.md](phase2_pack_inventory.md)；`.gitignore` 改为只排除 `corpus/originals/`（体积与第三方版权）与 `storage/`、`dist/` | 归档 `dist/liuyao-phase2-corpus-20261002.zip`：92 个文件、8,677,232 字节，SHA-256 见清单文件；manifest、extracted、cleaned、assets、reports 现已随仓库交付 |
| 内容问题 1：DOC 分片数自相矛盾 | 来源页改为"分片表 31 片"（与 manifest/report 一致） | 见 `wiki/sources/src-3f8243c07930.md` 与 `corpus/reports/spotcheck/src-3f8243c07930.json` |
| 内容问题 2：对照页夸大冲突 | 标题与状态改为"表面分歧、前提不同"，并明确两份来源关注**不同环节** | 见 `wiki/comparisons/meihua-vs-liuyao.md` |
| 内容问题 3：段落统计口径混淆 | 报告与 manifest 统一为"提取器分块数"与"清洗段落锚点数"两个字段，并说明差异原因；锚点数以清洗文件中的 `<!-- ¶NNNN -->` 计数为准 | 见各 `corpus/reports/src-*.md` 第 4 节 |
| 内容问题 4：旧 DOC 核对表述过强 | 抽查记录改为"与自实现解析器输出一致 + 原件原始字节独立命中"，并声明**未做**第二种解析器/渲染器对照 | `verify` 新增"原始载体独立命中"检查（txt=GB18030 原始字节、doc=UTF-16LE 原始字节、docx=`word/document.xml`），当前 4/4 命中 |

修复后的校验结果：`node tools/corpus-cli.ts verify --verbose` → **通过 82 项、警告 0、失败 0**（较修复前新增：清洗文本链接、卦图页图、正文非空、状态一致性、原始载体命中）。隔离复验共 4 个场景全部通过。
