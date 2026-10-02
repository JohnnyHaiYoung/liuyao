# 资料处理区（阶段 2 小样本已建立）

开发阶段从 `F:\道教\六爻` **只读**导入资料到本目录；运行时只使用项目内相对路径，不访问 F 盘。处理流程与验收证据见 [第二阶段交付说明](../docs/phase2_delivery.md)，格式与版本约定见 [技术架构](../docs/technical_architecture.md)。

| 目录 | 内容 | 阶段 2 状态 |
| --- | --- | --- |
| `originals/` | 保持目录结构的原件副本，复制前后核对 SHA-256 | 6 份样本（TXT×2、DOCX、旧 DOC、文字层 PDF、扫描 PDF），约 1.4 MB |
| `extracted/` | 忠实于原件的机器提取文本，带页/段边界与疑点 | 6 份；扫描件为 Windows 内建 OCR 结果 |
| `cleaned/` | UTF-8 Markdown，只做编码/换行/段落/标题清洗，段落带 `<!-- ¶NNNN -->` 锚点 | 6 份 |
| `assets/` | Markdown 引用的原页图与必要图片，按 `source_id` 分目录 | 7 张 JPEG（扫描件 5 页 + 文字层 PDF 2 页） |
| `reports/` | 每份来源的质量报告；人工抽查原始记录在 `reports/spotcheck/<source_id>.json` | 6 份报告 |
| `manifest.jsonl` | 一行一个来源的机器可读登记（哈希、路径、处理、覆盖、质量、关系） | 6 行 |

## 重跑命令（在项目根目录）

```bash
node tools/corpus-cli.ts import                 # 从 F 盘只读复制 + 校验哈希 + 登记
node tools/corpus-cli.ts extract --all          # 按格式提取（TXT/DOCX/DOC/PDF 文字层）
node tools/corpus-cli.ts ocr --source <id> --pages 1-5     # 扫描 PDF：渲染 + 离线 OCR
node tools/corpus-cli.ts assets --source <id> --pages 1-2  # 生成页面图资产（JPEG）
node tools/corpus-cli.ts clean --all            # 生成清洗 Markdown
node tools/corpus-cli.ts report --all           # 生成质量报告
node tools/corpus-cli.ts verify                 # 校验哈希、相对链接、定位与 F 盘未变
node tools/corpus-cli.ts status                 # 汇总
```

重跑是幂等的：同哈希只登记一次；`clean`/`report` 覆盖机器产物，不会改动 `wiki/` 下的人工内容。
