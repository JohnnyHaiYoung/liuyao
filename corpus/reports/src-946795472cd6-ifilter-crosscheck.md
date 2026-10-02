# 独立对照报告（IFilter）：src-946795472cd6

- 格式：docx
- 独立路径：Office OOXML IFilter (OFFFILTX.DLL)，经 `query.dll!LoadIFilter` 在进程内调用（Windows/Office 自带，离线，未联网、未安装任何包）
- 自实现路径：`tools/lib/office.ts`（ZIP + word/document.xml）
- 命令：`powershell -File tools/offline/ifilter-extract.ps1 -InputPath <原件> -OutPath storage/tmp/ifilter-docx.txt`

## 原始输出与重复检测

| 项目 | 值 |
| --- | ---: |
| IFilter 原始字符 / 汉字 | 3251 / 2261 |
| 检测到的重复倍数 | 1（未检测到整体重复） |
| 还原后字符 / 汉字 | 3251 / 2261 |
| 自实现字符 / 汉字 | 3100 / 2261 |

## 覆盖比对

- 自实现文本的 52 个段落中，有 **50** 个（96.2%）能在 IFilter 输出中找到前 14 字
- 关键抽查串「大象指原卦原象」在 IFilter 输出中出现 **1** 次（1 次为正常）

## 结论

1. 未检测到整体重复；IFilter 与自实现两条路径的正文覆盖率见上表。
2. 差异通常来自换行/分段与域代码写法，需要逐段抽查确认，不能只看总数。

## 边界

- IFilter 由 Windows/Office 提供，属于**开发机自测**用参照物，不是第三方独立核对，也不进交付包的运行时依赖。
- IFilter 输出保存在 `storage/tmp/`（不入包）；本报告记录的是本次运行结果与命令，便于复跑。

