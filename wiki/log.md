# Wiki 维护记录

## 2026-09-30 ingest | 六爻取用神之辩证看法

建立 Wiki 编写规则、索引、一个来源页和「取用神」概念页。该短文已读完，作者与转引古书未核实；「锁定用神」明确保持待验证状态。原始 F 盘文件未修改。

## 2026-10-02 ingest | 阶段 2 小样本（6 份来源）

处理小样本 6 份（TXT×2、DOCX、旧 DOC、文字层 PDF、扫描 PDF），每份都有包内原件、忠实提取文本、清洗 Markdown、质量报告与 manifest 记录。原始 F 盘文件未修改，复制前后核对 SHA-256。

- 新增来源页：[src-25fcddea758b](sources/src-25fcddea758b.md)、[src-946795472cd6](sources/src-946795472cd6.md)、[src-3f8243c07930](sources/src-3f8243c07930.md)、[src-e6fc8612e955](sources/src-e6fc8612e955.md)、[src-f3f838d501b1](sources/src-f3f838d501b1.md)。
- 更新来源页：[src-08862b06aea9](sources/src-08862b06aea9.md)：补齐包内原件、提取/清洗文本路径与段落锚点；保留 2026-09-30 的来源判断与「锁定用神」待验证状态，未改写原结论。
- 更新概念页：[取用神](concepts/yongshen.md)：加入 3 份新来源的正文主张（按六亲取用神、宠物取子孙、学业取父母、用神不现时的条件），并标注**不同来源的适用条件不可合并**。
- 新增对照页：[梅花易数起卦与六爻断卦的边界](comparisons/meihua-vs-liuyao.md)：并列 `src-25fcddea758b`（反对混用）与 `src-f3f838d501b1`（主张灵活起卦）的相反立场，分析冲突来自「起卦环节 vs 断卦环节」的前提差异，不裁决。
- 索引更新：来源表加入覆盖范围与质量状态；明确「6 份小样本不是完整知识体系」。

质量与工具记录：

## 2026-10-02 fix | 按第二阶段独立验收记录修复（`docs/phase2_acceptance_2026-10-02.md`）

验收方判定「暂不通过」，列出 5 个 P1 阻断项与 4 项内容问题；已逐项修复并复验：

- P1-1 清洗 Markdown 的来源链接：由 `../sources/<id>.md` 改为 `../../wiki/sources/<id>.md`；`verify` 的链接检查范围从只扫 `wiki/` 扩展到同时扫 `corpus/cleaned/`（并先剔除代码块/行内代码，避免把示例当链接）。
- P1-2 卦图与图文状态：文字层 PDF 由"仅第 1–2 页图 + 整本 usable"改为**全部 23 页原页图随包**、清洗文本按页嵌入图片，并在含 `██` 的 **20 页**内逐页标注"本页卦例不作为默认规则"；该来源质量状态由 `usable` 降为 `needs_review`（见其来源页与索引）。扫描件 5 页图同样嵌入其清洗文本。`verify` 新增检查：凡含 `██` 的页必须有原页图引用。
- P1-3 同哈希别名丢失：`import` 现在循环内实时更新哈希索引，同哈希的后续路径一律并入 `aliasSourcePaths`，主路径固定为首次导入路径；用隔离脚本验证同批、分批两种顺序共 3 个场景。
- P1-4 空提取误判：提取正文非空白字符 < 20 即判 `failed`、写入原因与重试指引，`clean` 拒绝为 `failed` 来源生成清洗文件；`verify` 新增"状态与产物一致性"检查。
- P1-5 自包含交付：新增 `node tools/corpus-cli.ts pack`（零依赖 ZIP、固定时间戳、包内 `PACK-MANIFEST.txt` 记录每个文件 SHA-256），产出归档并生成 [docs/phase2_pack_inventory.md](../docs/phase2_pack_inventory.md)；`.gitignore` 改为只排除 `corpus/originals/`（体积与第三方版权）与 `storage/`，manifest、extracted、cleaned、assets、reports 均随仓库交付。
- 内容问题：修正 DOC 来源页分片数（31 片，与 manifest 一致）；对照页标题改为"表面分歧、前提不同"；报告区分"提取器分块数"与"清洗段落锚点数"；旧 DOC 的核对改为"自实现解析器输出比对 + 原始载体独立命中"，不再写成独立原件核验。

质量与工具记录：

- 旧 DOC 使用自实现的 OLE2 + FIB + 分片表解析（本机无 LibreOffice/antiword，Word COM 在沙箱内挂起）。
- 扫描 PDF 使用 Windows 内建 PDF 渲染 + Windows.Media.Ocr（zh-Hans-CN，离线，未调用任何云 OCR）。
- 文字层 PDF 使用自实现的 PDF 对象/内容流/ToUnicode 解析；发现该文字层是 OCR 产物，已在其来源页记录形近字风险。
- 全部来源的处理方式、覆盖范围、未处理范围与工具版本见 [corpus/manifest.jsonl](../corpus/manifest.jsonl) 与 [corpus/reports/](../corpus/reports/)。
