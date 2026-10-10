# 本地 Wiki 扩充第一批 · 研发交付说明

- 分支：`wiki-batch1`（自 `main@e5e8b31` 分叉，与第五阶段 Docker 并行，未合并）
- 提交：`f0d4fe3`（设计）→ `53ff19f`（导入）→ `433a5be`（来源页/目录）→ `162b454`（收录范围模块）→ `90b0bea`（概念页）→ `d2a3e18`（聊天接入）→ **复验修复**：`4b5442f`（P1-1 质量报告）→ `69a2351`（P1-2/P2-1 收录路由+四层分档）→ `eb2fc77d`（P2-2 迁移检查）
- 依据：[任务书](wiki_expansion_batch1_spec.md)、[研发提示词](wiki_expansion_batch1_developer_prompt.md)、[批次设计](wiki_expansion_batch1_design.md)、[独立验收报告](wiki_expansion_batch1_acceptance_d6d74d6_2026-10-09.md)
- 性质：**研发自测，非独立验收**；本批资料在独立验收并与第五阶段冻结版本对齐前，不进入正式发布包。

## 0. 复验修复摘要（2026-10-09 独立验收 d6d74d6）

| 阻断项 | 修复 | 提交 |
| --- | --- | --- |
| P1-1 质量报告未抽查却标 usable | 逐份补开头/中部/末尾/高风险段落抽查、否定词/卦象/爻位核对、疑字、作者版本证据；讲义正文未核对标 `needs_review`；报告/manifest/来源页/目录一致 | `4b5442f` |
| P1-2 收录问答误报/抢知识问题 | 五路区分（目录总览/具体文件/主题/本次引用/普通知识）；本次引用来自本轮实际 `Sx`；文件未命中时区分"无此文件名"与"相关主题存在" | `69a2351` |
| P1-3 缺可搬迁私有资料包 | 产出 `dist/liuyao-wiki-batch1-eb2fc77d-corpus.zip`（149 文件，含四份原件），解包到无 F 盘目录逐份哈希一致、无泄密；见 [包清单](wiki_expansion_batch1_pack_inventory.md) | 见包清单 |
| P2-1 四层统计为元数据计数 | 按磁盘事实（原件存在+哈希一致/清洗存在/来源页存在）与质量分档，新增"已核对可引用规则"一档 | `69a2351` |
| P2-2 迁移检查旧库夹具假设错误 | 按旧库是否已含 0002 分支断言（幂等 no-op 或新增表），`check:migration-phase4` 30/30 | `eb2fc77d` |

## 1. 交付物清单

| 类别 | 内容 |
| --- | --- |
| 原件（只读副本，不入 Git） | `corpus/originals/五行所属行业/六爻取用神诀窍.txt`、`五行所属行业/六神临六亲取象.txt`、`六爻断卦技法.txt`、`六爻特训班讲义 曲炜1 .txt` |
| manifest | `corpus/manifest.jsonl`（6 → 10 份） |
| 提取文本 | `corpus/extracted/src-{31cafa8c2634,777319b69476,fd45fbed3007,a76b03f471fe}.txt` |
| 清洗文本 | `corpus/cleaned/src-{…}.md`（4 份，带 `¶NNNN` 锚点） |
| 质量报告 | `corpus/reports/src-{…}.md`（4 份） |
| 来源页 | `wiki/sources/src-{…}.md`（4 份） |
| 概念页 | `wiki/concepts/yongshen.md`（并列新来源）、`liushen-liuqin.md`（新增）、`duangua-jifa.md`（新增） |
| 目录/索引 | `wiki/index.md`、`wiki/log.md`、`wiki/catalog.json`（16 页） |
| 收录范围问答 | `app/src/server/wiki/coverage.ts`（模块）+ `app/src/server/chat/planner.ts`（聊天接入） |
| 自测 | `app/scripts/check-wiki-batch1.mjs`（14 项） |
| 工具修复 | `tools/corpus-cli.ts`：`verify` 的原始字节核对按 manifest `inputEncoding` 解码（此前 TXT 一律 gb18030，UTF-8 讲义命中失败） |

## 2. 新增来源哈希与大小（重新计算，与盘点值一致）

| source_id | 文件（相对 F 盘） | SHA-256 | 大小 |
| --- | --- | --- | --- |
| `src-31cafa8c2634` | 五行所属行业\六爻取用神诀窍.txt | `31cafa8c2634…efa604` | 1,687 B |
| `src-777319b69476` | 五行所属行业\六神临六亲取象.txt | `777319b69476…a2f348` | 10,109 B |
| `src-fd45fbed3007` | 六爻断卦技法.txt | `fd45fbed3007…7086dab` | 27,886 B |
| `src-a76b03f471fe` | 六爻特训班讲义 曲炜1 .txt | `a76b03f471fe…074655780` | 554,630 B |

近名比对：`六爻断卦技法.txt`（`fd45fbed…`）与 `六爻断卦技法..txt`（`69b580d5…`）非逐字同一（17,542 vs 17,405 字符，后者无「TXT小说库」宣传头），记为疑似版本关系、**不合并**；近名旧版 DOC 未导入。

## 3. 检查结果（本分支实测）

| 检查 | 结果 |
| --- | --- |
| `npm run build`（app） | 退出码 0 |
| `npm run typecheck`（app） | 退出码 0 |
| `node tools/corpus-cli.ts verify` | **132 通过、0 警告、0 失败**（10 份来源定位链完整） |
| `node app/scripts/build-wiki-catalog.mjs --check` | 目录一致：16 页，哈希匹配 |
| `node --import … app/scripts/check-wiki-batch1.mjs` | **14/14** |
| `node app/scripts/check-orchestration.mjs` | **107/107**（阶段 4 意图判定未回退） |
| `node --import … app/scripts/check-phase4-e2e.mjs` | **66/66**（阶段 4 主流程未回退） |
| `npm run check:all -- --with-http --with-ui` | 见本轮后台运行结果（浏览器级 + 阶段 1 HTTP 回归） |

## 4. 可复跑命令

```powershell
cd E:\workspace-ai\xuanxue\liuyao
git checkout wiki-batch1
node tools\corpus-cli.ts verify
node app\scripts\build-wiki-catalog.mjs --check
node --import ./app/scripts/lib/register-ts.mjs app/scripts/check-wiki-batch1.mjs
cd app
npm run typecheck
npm run build
npm run check:all -- --with-http --with-ui
```

## 5. 收录范围四层问答（实测输出）

| 问法 | 回答 | 来源 |
| --- | --- | --- |
| 你录入了哪些资料 / 有多少本书 | 已导入原件 10、已提取/清洗 10、已编入 Wiki 10，附逐份明细 | 程序从 manifest + catalog 生成 |
| 有没有六爻断卦技法这本书 | `src-fd45fbed3007` 六爻断卦技法.txt｜提取=是｜编入=是 | 程序子串匹配 |
| 收录了六爻取用神诀窍吗 | `src-31cafa8c2634` …｜提取=是｜编入=是 | 程序子串匹配 |
| 收录了不存在书名吗 | 尚未登记/尚未编入，不编造"已读过" | 程序判定空结果 |
| 这次引用了什么 | 由本轮实际选中并标注的 `Sx` 编号回答 | 正常来源引用机制 |

模型**不得**从本轮 `S1/S2` 反推全库总数；三层（已导入/已提取/已编入）与本次使用严格区分。

## 6. 实际覆盖与质量边界（如实登记，不把前一环写成后一环成立）

- **文件已导入**：4 份原件副本 + 哈希登记（✓）。
- **文字可读**：4 份均全文提取并清洗为 Markdown（✓；讲义 383 段）。
- **条目可引用**：取用神诀窍（1 段全文）、六神取象（6 神×6 亲）、断卦技法（规则条目）已编入来源/概念页（✓）；**讲义仅编入章节目录，正文规则未逐段核对**。
- **现实预测**：全部断语/卦例仅作来源说法，`needs_review` 段落不作默认规则；不构成现实预测正确性（不成立）。

质量边界：`src-777319b69476`（转载无作者）、`src-fd45fbed3007`（署名「林潮」、卦例段录入错字多）、`src-31cafa8c2634`（无作者「诀窍」转述）、`src-a76b03f471fe`（「曲炜」网络转载、梅花/六爻分轨、正文未逐段核对）。

## 7. 未完成项与边界

1. 讲义正文各章节的规则**未逐段核对编入**（仅章节目录），需后续批次逐章处理。
2. 真实模型 API 本轮**未重测**（按任务书约定，文案/资料规则无需调用计费 API）；`check:all` 的浏览器/HTTP 回归用假模型。
3. 20 条构建动态追踪提示 + standalone 发布包核验仍归**第五阶段**；本批资料独立验收后由第五阶段在冻结版本对齐镜像清单。
4. 本批未合并 `main`；与第五阶段 Docker 的合入顺序与包内清单对齐由验收方/第五阶段研发协调。
