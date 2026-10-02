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

- 旧 DOC 使用自实现的 OLE2 + FIB + 分片表解析（本机无 LibreOffice/antiword，Word COM 在沙箱内挂起）。
- 扫描 PDF 使用 Windows 内建 PDF 渲染 + Windows.Media.Ocr（zh-Hans-CN，离线，未调用任何云 OCR）。
- 文字层 PDF 使用自实现的 PDF 对象/内容流/ToUnicode 解析；发现该文字层是 OCR 产物，已在其来源页记录形近字风险。
- 全部来源的处理方式、覆盖范围、未处理范围与工具版本见 [corpus/manifest.jsonl](../corpus/manifest.jsonl) 与 [corpus/reports/](../corpus/reports/)。
