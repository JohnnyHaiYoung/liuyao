# 第二阶段独立复验（二次，提交 `39703ef`，2026-10-04）

**结论：暂不通过。** 上次的两项 P1 在独立复验中均已修复；但本次提交的 PDF 抽查记录 JSON 无法解析，使报告生成命令失败，实际归档仍携带过期报告。新增的混合批次复验脚本还会改动并清理正式资料目录，不能作为安全的隔离复验工具运行。

## 已确认通过

| 项 | 独立结果 |
| --- | --- |
| 交接包完整性 | `dist/liuyao-phase2-corpus-20261004.zip` 为 8,760,381 字节，SHA-256 `fff93703ddd8ca0befa6c119bb13588f35a064dc6c45948a30da7b270ac0b4d3`，与 `docs/phase2_pack_inventory.md` 一致。直接读取 ZIP 并独立复核 `PACK-MANIFEST.txt`：124 个文件大小及 SHA-256 全部一致，另 1 个文件为清单本身，共 125 个文件。 |
| 无 F 盘解包校验 | 将实际 ZIP 解包到 `storage/acceptance-phase2-39703ef-unpacked`，只在该副本中把 `sourceRoot` 改为不存在的 `Z:\absent-liuyao-source`，执行 `node tools/corpus-cli.ts verify`：96 通过、6 条外部原件不可访问警告、0 失败，退出码 0。前次两处失效链接已消除。 |
| 异常混合批次 | 把打包工具复制到独立的 `storage/acceptance-phase2-39703ef-fixture`，导入坏 DOC、空 TXT、正常 TXT。`extract --all` 报 1 个解析异常并以退出码 1 结束，后续来源仍处理；manifest 中坏 DOC 为 `failed/failed` 且有 2 条原因，空 TXT 为 `failed/failed`，正常 TXT 为 `processed/usable`；`clean --all` 只为正常 TXT 写清洗文件。前次“失败不留痕”已修复。 |
| 校勘标记 | 第 21 页转写文件保留「逢中」字形，另标注「疑为逢冲」的校勘意见，并说明 OCR 文字层不能充当独立核对；来源继续为 `needs_review`。 |

## 未通过项

### P1-1 抽查记录 JSON 无效，报告不能重跑

`corpus/reports/spotcheck/src-e6fc8612e955.json` 的 `method` 字段包含未转义的 `"背书"` 字面双引号。独立解析六份 `spotcheck/*.json`，只有这一份失败。对解包副本运行：

```text
node tools/corpus-cli.ts report --source src-e6fc8612e955
SyntaxError: Expected ',' or '}' after property value in JSON at position 194 (line 3 column 162)
退出码 1
```

因此交付说明中“已更新 spotcheck JSON 并重跑 report”的陈述与实际交付不符。请先修正 JSON 语法，再在隔离副本和正式目录分别确认 `report --source` 可执行。建议让 `verify` 检查每份抽查 JSON 能否解析；当前 102 项通过的自检没有覆盖这一点。

### P1-2 实际归档仍携带旧的 PDF 质量报告

实际 ZIP 内的 `corpus/reports/src-e6fc8612e955.md` 第 53 行仍写“仅导出第 1–2 页原页图”，第 92 行仍写“第 3、20 页已转写，其余 18 页未转写”。包内已有 23 页图片、20 份转写；报告与产物相反。`39703ef` 的提交改了 `spotcheck` JSON，却没有更新这份生成报告；上面的 JSON 错误也阻止了重跑。

任务书要求逐份质量报告准确写明处理范围及未处理范围。请修正 JSON、重跑报告、重新打包，再对**新归档内的报告**核对这两处文字。单独改交付说明不能替代修复随包报告。

### P1-3 新复验脚本会碰正式资料，不能安全重复执行

`tools/offline/accept-invalid-batch-test.mjs` 把项目根目录硬编码为 `E:\workspace-ai\xuanxue\liuyao`，并直接备份、改写正式 `corpus/manifest.jsonl`，将测试原件导入正式 `corpus/originals/`。`finally` 又无条件删除该目录中名为 `broken.doc`、`empty.txt`、`ok.txt` 的文件，并按文件头内容扫描删除正式 `corpus/extracted/` 与 `corpus/cleaned/` 中的文件。若这些名字与真实资料重合，执行验收脚本就可能覆盖或删除资料。脚本随 `tools/` 进入资料包，部署到其他目录后还会继续指向旧的 E 盘路径。

出于上述原因，本轮**没有运行该脚本**；使用独立工具副本完成了同一混合批次复验。请让脚本从自身路径推导项目位置，并只在新建、明确限定的隔离项目目录内运行；不得修改或清理正式 manifest、原件与清洗产物。`accept-unpack-test.mjs` 也应避免硬编码根目录和按名称猜测待验 ZIP，至少明确接收归档路径与安全的解包目标。

## 下次复验门槛

1. 六份 `spotcheck/*.json` 全部可解析；`report --source src-e6fc8612e955` 成功，并在生成报告中准确记录 23 页图、20 页转写及疑点。
2. 重新生成归档，核对其 SHA-256、包内逐文件哈希、无 F 盘解包校验，以及**包内** PDF 质量报告内容。
3. 混合批次复验脚本仅操作独立临时项目，不修改正式资料；从任意部署目录运行时使用被测目录，而不是硬编码本机路径。

**最终结果：提交 `39703ef` 修复了前次两项 P1，但第二阶段仍不能签收。**
