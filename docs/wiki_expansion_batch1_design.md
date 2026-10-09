# 本地 Wiki 第一批 · 批次设计（研发，先于资料处理）

基线：`main@e5e8b31`，独立分支 `wiki-batch1`。依据 [任务书](wiki_expansion_batch1_spec.md) 与 [研发提示词](wiki_expansion_batch1_developer_prompt.md)。本设计只定方案；资料处理、质量报告与目录问答的实测见后续 `docs/wiki_expansion_batch1_delivery.md`。

## 1. 来源选择与重复版本

四份候选已在 F 盘核对存在、大小与 SHA-256 与 `source_inventory.csv` 盘点值一致，全部导入：

| 相对 F 盘路径 | SHA-256 | 大小 | 编码候选 | 本批用途 |
| --- | --- | --- | --- | --- |
| `五行所属行业/六爻取用神诀窍.txt` | `31cafa8c…` | 1,687 B | gb18030 | 与既有「取用神」并列，不合并为通用规则 |
| `五行所属行业/六神临六亲取象.txt` | `777319b6…` | 10,109 B | gb18030 | 六神/六亲术语与取象来源页；区分原文举例/断语/可计算盘面字段 |
| `六爻断卦技法.txt` | `fd45fbed…` | 27,886 B | gb18030 | 规则/案例候选；先与近名版比对，不凭文件名合并 |
| `六爻特训班讲义 曲炜1 .txt` | `a76b03f4…` | 554,630 B | utf-8-sig | 长讲义：先全文可定位提取 + 章节目录；仅已核对章节编入 Wiki，梅花/六爻分轨，网页导航/转载信息单列 |

**近名版本比对（已抽样，不合并）**：
- `六爻断卦技法.txt`（`fd45fbed…`）开头带「TXT小说库」宣传头，正文署名「林潮」；与 `六爻断卦技法..txt`（`69b580d5…`）正文**非**完全相同（17,542 vs 17,405 字符，后者无宣传头）。二者记为 `suspectedVersionRelation` 关系、`aliasSourcePaths` 登记，不合并。
- 另有近名 `.doc`（`23d38b32…`）与 `-断卦技法与实例分析..doc`（`8eaab430…`）为二进制旧 DOC，本批不导入，仅在来源页备注。

## 2. 转换方式

复用现有管线 `node tools/corpus-cli.ts` 的 `import → extract → clean → report`，逐文件执行：
- `import`：只读复制 F 盘原件进 `corpus/originals/<相对路径>`，重新计算 SHA-256 并与盘点值比对；不符即暂停该文件并记录。
- `extract`：按候选编码解码（gb18030×3、utf-8-sig×1）；记录替换字符/控制字符数。
- `clean`：生成 `corpus/cleaned/src-<hash12>.md`，保留稳定段落锚点 `¶NNNN`、删改记录、疑字与乱码标记；长讲义按章节目录切分。
- `report`：每份来源一份质量报告（解码、章节边界、原件量、提取范围、编入范围、抽查、遗漏/错字、作者与版本证据等级）。
- `verify`：跑 `node tools/corpus-cli.ts verify` 确认 manifest/原件/提取/清洗/页图定位链完整。

## 3. Wiki 主题与覆盖

1. **来源页 ×4**（`wiki/sources/src-<hash12>.md`），按 `wiki/schema.md` 最少字段记录主张，`status` 至少为 `source_claim`，未核准处 `unverified`/`needs_review`。
2. **概念/对照页**：
   - `concepts/yongshen.md`：补「六爻取用神诀窍」的同主题分歧（**并列不合并**），保留既有 4 来源主张与旧快照。
   - 新增 `concepts/liushen-liuqin.md`（六神/六亲取象）：区分原文举例、断语与可计算盘面字段。
   - 新增 `concepts/duangua-jifa.md` 或按主题拆分（断卦技法规则条目，方法标签明确，分歧处 `contested`）。
   - 长讲义：先建 `sources/` 页记录章节目录；仅已核对章节的规则进入概念页，其余标「未核对章节，未编入」。
3. 更新 `wiki/index.md`（来源表新增 4 行）、`wiki/log.md`（每条编入记录）、`wiki/catalog.json`（`app/scripts/build-wiki-catalog.mjs` 重建），标题/别名/主题设为实际提问可命中的词。

## 4. 目录问答（收录范围）实现

新增 `app/src/server/wiki/coverage.ts`：只读 `corpus/manifest.jsonl` + `wiki/catalog.json`，程序生成四层回答——「已导入原件 / 已提取清洗 / 已编入 Wiki / 本次使用证据」。接入聊天编排：对「录入了哪些资料 / 有多少本书 / 某文件收录了吗 / 这次引用了什么」给出不同且正确的清单，模型不得从本轮 `S1/S2` 反推全库总数。最终来源数、文件名、覆盖范围与质量状态由程序生成。

## 5. 与第五阶段 Docker 发布的版本边界

- 本批在 `wiki-batch1` 分支独立提交；第五阶段镜像继续以**已独立验收的六份来源**为冻结点。
- 本批 `wiki/`、`corpus/`、manifest、目录的改动**不进入**正式发布包，直至本批独立验收通过并由第五阶段研发在明确冻结点对齐清单与哈希。
- 旧会话已保存的摘录/页哈希不变，新问题才读新版 Wiki。

## 6. 交付与验收对齐

交付 `docs/wiki_expansion_batch1_delivery.md`：四份原件副本、manifest、提取/清洗文本、质量报告、来源/主题 Wiki 页、目录重建、收录范围回答实测、可重跑命令、哈希清单、未完成项、Git SHA。报告分列「文件已导入 / 文字可读 / 条目可引用 / 现实预测」，不把前一项写成后一项成立；研发自测不等于独立验收。
