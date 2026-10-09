# 第二阶段独立验收结论（提交 `18bcb3b`，2026-10-04）

**结论：第二阶段通过。** 本结论只覆盖[第二阶段研发任务书](phase2_development_spec.md)的小样本资料处理、来源追溯、Wiki 与资料交接包；不证明整库已完成、Agent 已调用 Wiki、排盘算法正确或占断有效。前两轮问题与证据见[首次验收](phase2_acceptance_2026-10-02.md)、[第一次复验](phase2_reacceptance_2026-10-04.md)和[提交 `39703ef` 的复验](phase2_reacceptance_39703ef_2026-10-04.md)。

## 独立复验记录

| 验收项 | 本轮结果 |
| --- | --- |
| 工作目录完整性 | `git status --short` 初始为空；`node tools/corpus-cli.ts verify`：**108 通过、0 警告、0 失败**。6 份 `corpus/reports/spotcheck/*.json` 均能独立解析；manifest 有 6 个不同哈希，覆盖 TXT、DOCX、旧 DOC、文字层 PDF、扫描 PDF 五类格式。 |
| 报告可重跑 | 在实际归档的解包副本内运行 `node tools/corpus-cli.ts report --source src-e6fc8612e955`：退出码 **0**，成功写出质量报告。工作目录与归档原始报告均记录全部 23 页图、20 个含卦图页的转写和 `needs_review` 状态；旧的“仅第 1–2 页图”“未转写的 18 页”结论不再出现。 |
| 归档完整性 | `dist/liuyao-phase2-corpus-20261004.zip` 为 **8,763,376 字节**，SHA-256 `7216967d33e6645003976c6e344af3074f2b64fb51657550bf12d7776010e037`，与[交接包清单](phase2_pack_inventory.md)一致。实际 ZIP 有 125 个文件；解包后逐一核对 `PACK-MANIFEST.txt` 列出的 **124/124** 个文件哈希，一致。 |
| 无 F 盘交付 | 在明确检查为不存在的新目标 `storage/tmp/accept-unpack-independent-18bcb3b` 中解包实际 ZIP，副本 `sourceRoot` 指向不存在的 Z 盘。包内 `verify`：**102 通过、6 条外部原件不可访问警告、0 失败**，退出码 0。相对链接和来源追溯在交付形态下通过。 |
| 异常处理与隔离 | 运行改写后的混合批次脚本：坏 DOC 为 `failed/failed` 且有原因；空 TXT 为 `failed/failed`；正常 TXT 为 `processed/usable` 且有清洗文件；批量提取报告失败数并返回非零，脚本 **4/4 通过**。运行前后正式 `corpus/manifest.jsonl` 与 `corpus/originals/` 全部文件的 SHA-256 清单完全一致；临时项目根已清理。 |
| 图文覆盖 | 文字层 PDF 的 23 页图片与 20 份卦图转写均存在；第 21 页「逢中／疑为逢冲」的原字与校勘意见已区分，该来源继续标 `needs_review`，卦图页不进入默认规则。 |

## 非阻断改进建议

`tools/offline/accept-unpack-test.mjs` 目前用路径字符串前缀判断目标是否位于 `storage/tmp`，并在解包前递归清空目标。实际测试使用了预先确认不存在、且位于该目录下的专用路径，因此本次验收没有误删；后续可改用 `path.relative` 判断目录边界，禁止把 `storage/tmp` 本身作为目标，并在已有非空目录时要求显式覆盖参数。这是工具防误用建议，不改变本次归档内容和交付校验结论。

**最终结果：第二阶段签收通过。** 下一阶段可继续审查第三方 Skill 与排盘算法；本阶段 `needs_review` 的资料和人工校勘疑点仍须按来源页限制使用。
