# 清洗文本

这里是机器生成的统一 UTF-8 Markdown：每份来源一个 `<source_id>.md`，页头写明来源页、包内原件、忠实提取文本、覆盖范围与质量状态。

- 段落锚点：`<!-- ¶NNNN <稳定哈希> -->`，Wiki 主张用它定位；PDF/OCR 来源另按页分节（`## 第 N 页（PDF 实际页码）`）。
- 图片：以相对路径引用包内资产，例如 `![第 1 页原页图](../assets/src-f3f838d501b1/page-001.jpg)`；含方块占位字符（`██`）的卦图页会在页内标注，并提示卦例不作默认规则。
- 清洗范围：只做编码、换行、段落、标题层级与可确认杂质的处理；**不订正错别字、不改写卦例与术语**。做了哪些改动写在对应的 `../reports/<source_id>.md` 第 7 节。

重跑覆盖本目录内容（不会改动 `wiki/` 下的人工内容）：

```bash
node tools/corpus-cli.ts clean --all
```

这些文件随项目打包；完整交接包用 `node tools/corpus-cli.ts pack` 生成，清单见 [docs/phase2_pack_inventory.md](../../docs/phase2_pack_inventory.md)。
