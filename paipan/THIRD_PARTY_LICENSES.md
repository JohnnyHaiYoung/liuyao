# 第三方许可记录（paipan 模块）

本模块只采用一个运行时依赖，另有一个仅用于开发期独立对照的实现。

## 运行时依赖（进入发布包）

| 包 | 版本 | 许可 | 作者 | 用途 |
| --- | --- | --- | --- | --- |
| `lunar-typescript` | 1.8.6 | MIT | 6tail | 公历/农历/干支/节气换算（Node 历法核心） |

- 许可文本随包提供：`paipan/node_modules/lunar-typescript/package.json` 的 `license: MIT`，仓库 `https://github.com/6tail/lunar-typescript`。
- 该包**零传递依赖**（`dependencies` 为空），因此没有额外的第三方许可需要传递。

## 开发期对照实现（不进生产链路）

| 包 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `solarlunar` | 3.1.0 | ISC | 不同作者的第二个实现，用于"独立实现对照"等级的历法核对 |

## 未采用的上游代码

`liuyao-skills`（MIT，© 2026 songgoldenwind-crypto）与 `fortune-liuyao-skill`（Apache-2.0 模板、版权行未填写）的源码**只作审查与对照**，本阶段未复制进生产依赖。若后续采用其中任何代码，必须在此文件补充：仓库 URL、固定提交 SHA、文件清单哈希、许可原文位置，以及本项目对它的修改说明。审查记录见 [../docs/phase3_upstream_audit.md](../docs/phase3_upstream_audit.md)。

## Python 侧（仅开发期）

`lunar_python 1.4.8`（MIT，6tail）安装在 `storage/pylibs`（`storage/` 不进发布包），只用于开发期对照与本项目自行复核上游结论。
