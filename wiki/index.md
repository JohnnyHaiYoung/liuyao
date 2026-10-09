# 六爻 Wiki 索引

状态：阶段 2 小样本 + 第一批扩充（4 份，与第五阶段 Docker 并行）。只收录**已按来源 ID 与段落/页码定位、且可回到包内原件**的内容；不代表已经确认传统流派、规则正确性或占断准确率。当前样本 10 份（阶段 2 六份 + 第一批四份），处理范围与质量状态见下。

## 阅读路径

- [Wiki 编写规则](schema.md)：条目类型、出处、状态和冲突的记录方式。
- [资料处理目录](../corpus/README.md)：原件、提取文本、清洗文本、图片与质量报告的位置。
- [资料清单（manifest）](../corpus/manifest.jsonl)：每份来源的哈希、处理方式与覆盖范围（机器可读）。
- 概念页：[取用神](concepts/yongshen.md)（5 个来源的正文证据，并列不合并）、[六神临六亲取象](concepts/liushen-liuqin.md)（单一来源取象词典）、[断卦技法](concepts/duangua-jifa.md)（基础口诀与实例，卦例 `needs_review`）。
- 对照页：[梅花易数起卦与六爻断卦的边界](comparisons/meihua-vs-liuyao.md)（真实分歧，并列不裁决）。
- [维护记录](log.md)：每次编入或修订的记录。

## 来源页与覆盖范围（阶段 2）

| 来源 | 类型 | 覆盖范围 | 质量 | 备注 |
| --- | --- | --- | --- | --- |
| [src-08862b06aea9](sources/src-08862b06aea9.md) | TXT | 全文（14 段） | `usable` | 作者自称「道源」；引古书未核实 |
| [src-25fcddea758b](sources/src-25fcddea758b.md) | TXT | 全文（146 段） | `usable` | 自述摘自邵伟华/邵伟中讲义 |
| [src-3f8243c07930](sources/src-3f8243c07930.md) | 旧 DOC | 全文（285 段） | `usable` | 自实现 OLE2 解析；含线上排盘残留 |
| [src-946795472cd6](sources/src-946795472cd6.md) | DOCX | 全文（122 段） | `usable` | 文件内无图片、无表格 |
| [src-e6fc8612e955](sources/src-e6fc8612e955.md) | 文字层 PDF | 整本 23 页 | `needs_review` | 文字层为 OCR 产物且 20/23 页含 `██` 爻位占位；已附**全部 23 页**原页图并在页内标注，卦例不作默认规则 |
| [src-f3f838d501b1](sources/src-f3f838d501b1.md) | 扫描 PDF（OCR） | 第 1–5 页（整本） | `needs_review` | Windows 内建离线 OCR；未逐字校对；已附 5 页原页图 |
| [src-31cafa8c2634](sources/src-31cafa8c2634.md) | TXT | 全文（1 段） | `usable` | 无署名；取用神「诀窍」式转述，不可当古籍原文 |
| [src-777319b69476](sources/src-777319b69476.md) | TXT | 全文（9 段） | `usable` | 转载无作者；六神临六亲取象词典式转述 |
| [src-fd45fbed3007](sources/src-fd45fbed3007.md) | TXT | 全文（28 段） | `usable` | 署名「林潮」；卦例段录入错字多、按 `needs_review`；近名 ..txt 已比对不合并 |
| [src-a76b03f471fe](sources/src-a76b03f471fe.md) | TXT | 全文已提取（383 段）；仅编入章节目录 | `usable` | 「曲炜」讲义转载；梅花易断/六爻占断分轨 |

## 当前覆盖与边界

- 本 Wiki 目前覆盖 10 份（阶段 2 六份 + 第一批四份），**不是完整六爻知识体系**；其余资料尚未处理，Agent 不得把这里的条目当成完整知识。
- `needs_review` 来源（`src-f3f838d501b1`）中的疑点段落不得作为默认规则引用。
- 涉及疾病、婚姻、财务等现实断言只作为来源中的说法，不作为已证实结论。
- 具体卦例需要完整输入并由排盘程序处理；本阶段没有排盘程序，Wiki 也不提供盘面。

## 查询约定

Agent 先读本索引，再读与问题有关的页面。页内没有可追溯证据时，回答应注明是一般解释或待核对观点；不得虚构书名、页码、流派归属。引用时使用页面中的 `source_id` 与 `¶NNNN` 定位（PDF 另有实际页码），可回到 `corpus/cleaned/` → `corpus/extracted/` → `corpus/originals/`。
