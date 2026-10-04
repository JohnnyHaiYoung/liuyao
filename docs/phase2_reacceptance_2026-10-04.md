# 第二阶段独立复验记录（2026-10-04）

**结论：暂不通过。** 本次按[第二阶段研发任务书](phase2_development_spec.md)第 9 节复验小样本资料、Wiki、处理工具及资料交接包。第一阶段网站的运行验收与后续 Agent、排盘功能不在本次范围。验收方未修改生产代码、Wiki 或语料；隔离复验产物位于 Git 忽略的 `storage/acceptance-phase2-recheck-20261004-*`。

## 交付与复验结果

| 检查项 | 结果与证据 |
| --- | --- |
| 工作目录自检 | `node tools/corpus-cli.ts verify`：102 通过、0 警告、0 失败。此结果仅覆盖当前完整工作目录。 |
| 交接包完整性 | `dist/liuyao-phase2-corpus-20261004.zip` 存在，8,753,659 字节，SHA-256 为 `28cf4333e2a978d3384c34e6f31316de77e39f287e497eeb5c69cdd758394639`，与[打包清单](phase2_pack_inventory.md)一致。包内 123 个文件；独立核对 `PACK-MANIFEST.txt` 所列 122 个文件的大小和 SHA-256，均一致。 |
| 样本与来源 | 6 个不同哈希、5 类格式及六份项目内原件仍在；现有来源、清洗文本和 Wiki 主张的定位链条在工作目录可用。旧 DOC 已补充 Word 与 Windows IFilter 的独立文字对照记录；版式对齐仍按报告所述保留待复核。 |
| 图像与状态 | 文字层 PDF 的 23 页图片及 20 个含卦图页的转写文件均随包；抽看第 3、20、21 页原页图及转写。该来源标为 `needs_review`，含卦图页不作为默认规则。 |
| 同哈希别名 | 在隔离样本同批导入 `copy-a.txt`、`copy-b.txt`：manifest 只有一份来源，主路径为 `copy-a.txt`，别名保留 `copy-b.txt`。 |
| 空文件 | 隔离样本 `empty.txt` 提取后为 `failed/failed`，记录原因，无清洗文件。 |
| 第一阶段编译回归 | `app/` 下 `npm run typecheck`、`npm run build` 通过；未重新执行浏览器聊天、历史记录或模型 API 的端到端验收。 |

## 阻断项

### P1-1 解包后校验仍依赖缺失的清单文档

把实际 ZIP 解包到 `storage/acceptance-phase2-recheck-20261004-unpacked`，将该副本 `tools/sample-set.json` 的 `sourceRoot` 改为不存在的 `Z:\absent-liuyao-source`，执行 `node tools/corpus-cli.ts verify`：**96 通过、6 条 F 盘不可访问警告、2 失败，退出码 1**。两处失败分别为：

- `wiki/log.md` 指向 `../docs/phase2_pack_inventory.md`；
- `corpus/cleaned/README.md` 指向 `../../docs/phase2_pack_inventory.md`。

`tools/corpus-cli.ts` 的 `pack` 实现显式排除 `docs/phase2_pack_inventory.md`，但仍打包上述两个引用。按任务书第 8 节和第 9 节场景 8，解包后的相对链接及离线校验必须成立。修复时可把链接改指包内 `PACK-MANIFEST.txt`，或提供包内可用的清单页面，并重新生成归档；要对**实际新归档**解包复验，不能只在工作目录运行 `verify`。

### P1-2 损坏的旧 DOC 中断批量处理，失败状态没有记录

在隔离样本中导入一个 19 字节、扩展名为 `.doc` 但不是 OLE2 文档的文件，再运行 `extract --source src-b2ea43f1da74`，程序从 `tools/lib/office.ts:205` 抛出“不是 OLE2 复合文档”，退出而不写来源处理结果。manifest 中该来源仍为 `processing.status=pending`、`coverage.quality=needs_review`、`coverage.issues=[]`。运行 `extract --all` 时还会在此处中断，后续来源不再处理。`tools/corpus-cli.ts` 的 `commandExtract` 在调用格式解析器时缺少逐来源异常收敛。

任务书第 6、9 节要求失败如实记录，不能把异常留作无原因的待处理状态。修复后，单个来源的解析异常须写成 `failed`、保留错误原因及重试建议；批量处理应继续其他来源，并以非零退出码或汇总信息明确报告失败数。复验应同时覆盖损坏 DOC、零字节 TXT 和正常 TXT 混合批次。

## 交付文档与内容问题

1. `corpus/reports/src-e6fc8612e955.md` 第 6 节仍写“仅导出第 1–2 页原页图”，第 9 节仍写“只转写第 3、20 页、其余 18 页未转写”；实际包内已有 23 页图片、20 份转写，[转写目录说明](../corpus/figures/src-e6fc8612e955/README.md)也写“全部 20 页”。`docs/phase2_delivery.md` 第 13 节和旧 ZIP 文件名/数量同样滞后。请以最终交接包为准同步报告、来源页与交付说明，避免部署者误判可用范围。
2. 第 21 页的“逢冲应期”段落，文字层、清洗文本与转写页均写“逢**中**之期”，而所在章节与前句使用“逢**冲**”。这可能是原书印刷字形或 OCR 的问题，当前不据此断言转写错误；但转写页的“原页文字，与提取文本一致”不能只靠 OCR 文本作独立核对。建议对照高清原页确认该字，并在保留原文与校勘意见之间明确区分。该来源继续维持 `needs_review`。

## 下次复验门槛

1. 重打资料 ZIP，独立校验清单哈希；在无 F 盘的新目录解包，打开两处链接并运行 `verify`，只允许已说明的外部原件不可访问警告，不得有失败。
2. 在隔离混合批次中模拟坏 DOC、空 TXT、正常 TXT：失败来源需有 `failed` 和原因，正常来源仍能完成，且不生成空白“成功”清洗文件。
3. 同步文字层 PDF 的图片、转写覆盖状态与交付说明；核对第 21 页疑字并注明判定依据。

**最终结果：第二阶段暂不签收。** 前次五项阻断中的来源链接、图片保留、同哈希别名、空文件判定和实体归档均有实质改进；本轮仍有解包校验失败与异常处理失真两项阻断，修复后再复验。
