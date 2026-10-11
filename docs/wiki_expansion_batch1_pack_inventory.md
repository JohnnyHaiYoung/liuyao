# 本地 Wiki 第一批 · 私有资料包清单

- 绑定提交：`55eb3d14`（质量报告 Wiki 覆盖范围修正后的最终数据）
- 归档文件：`dist/liuyao-wiki-batch1-55eb3d14-corpus.zip`
- 归档 SHA-256：`beb60bead2f7edf39e3fe958df4468df5a648f0b39ec2f253d750b0ab9098df6`
- 文件数：150；字节：9,347,591（含阶段 2 六份 + 第一批四份的全部 corpus/wiki/目录）
- 包内清单文件：`PACK-MANIFEST.txt`（逐文件 SHA-256）

## 四份原件（在包内、哈希与 manifest 一致，不依赖 F 盘）

| source_id | 包内路径 | SHA-256 | 大小 |
| --- | --- | --- | --- |
| `src-31cafa8c2634` | `corpus/originals/五行所属行业/六爻取用神诀窍.txt` | `31cafa8c2634…efa604` | 1,687 B |
| `src-777319b69476` | `corpus/originals/五行所属行业/六神临六亲取象.txt` | `777319b69476…a2f348` | 10,109 B |
| `src-fd45fbed3007` | `corpus/originals/六爻断卦技法.txt` | `fd45fbed3007…7086dab` | 27,886 B |
| `src-a76b03f471fe` | `corpus/originals/六爻特训班讲义 曲炜1 .txt` | `a76b03f471fe…074655780` | 554,630 B |

## 解包到无 F 盘目录的验证结果

- 解包目录 `storage/tmp/relocate-batch1/`（无 F 盘访问）：四份原件 SHA-256 与包内 `corpus/manifest.jsonl` 逐份一致；`wiki/catalog.json`、`wiki/sources/*.md`、`wiki/concepts/*.md` 均存在。
- 泄密检查：包内不含 `.env`、`storage/`、`.db`、`.db-wal/.shm`、`.git`、`node_modules`、OCR 缓存或密钥（唯一命中的 `tools/offline/ocr-image.ps1` 是离线 OCR 工具脚本，非缓存/密钥）。

## 与正式发布包的边界

本归档是本批私有资料包，**不并入第五阶段正式发布包**；独立验收通过后由第五阶段研发在冻结点对齐镜像清单。
