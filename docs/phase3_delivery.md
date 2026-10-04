# 第三阶段交付说明：Skill 审查、历法口径与确定性排盘

版本：2026-10-04。依据 [第三阶段任务书](phase3_development_spec.md)。本阶段**不调用 LLM、不接入聊天、不读聊天历史、不访问网络**；阶段 1 聊天与阶段 2 资料未被改动。

## 1. 交付物清单

| 产物 | 位置 | 状态 |
| --- | --- | --- |
| 上游 Skill 审查报告 | [phase3_upstream_audit.md](phase3_upstream_audit.md) | 完成（两仓库固定提交、许可、依赖、行为、复用决定、两套解读方法边界单列） |
| 规则口径（人读 + 机器可读） | `paipan/rules/rule-profile.v1.json`（`liuyao-rule-profile.v1`） | 完成（每条附证据等级） |
| Node 历法决策 | [phase3_calendar_decision.md](phase3_calendar_decision.md) | 完成（采用 `lunar-typescript@1.8.6`，生产链路不引入 Python） |
| 排盘模块与 CLI | `paipan/src/*.ts`、`paipan/bin/paipan.ts` | 完成 |
| 核对工具与样例 | `paipan/scripts/*.mjs` | 完成（见第 3 节） |
| 本交付说明 | `docs/phase3_delivery.md` | 本文件 |

启动与复跑见第 5 节；生产依赖见 `paipan/package.json` 与 `paipan/THIRD_PARTY_LICENSES.md`。

## 2. 模块边界与输出契约

```text
六次爻值(初爻在前) + 时间/时区/日界  →  输入校验与规范化  →  历法适配器  →  排盘核心  →  盘面 JSON
```

盘面 JSON 关键字段（schemaVersion `liuyao-chart.v1`）：`input`（原始爻值与顺序、动爻位）、`calendar`（模式、日柱、月建、节气窗口、时区、日界、库与证据）、`chart`（本卦/变卦、宫与阶段、世应、旬空）、`lines[6]`（阴阳、动符、纳甲、六亲、六神、世应、旬空、变爻）、`hiddenLines`（伏神与飞神）、`unavailable`（缺项与原因）、`audit`（**不参与等价比较**）。

边界遵守情况：核心不调用 LLM、不读聊天历史、不联网；文本展示只读盘面（本阶段未做展示层）；非法爻值与错序标记返回可识别错误；自动历法模式缺时区/无效日期/超范围返回错误；手动模式缺字段按缺项降级。

## 3. 验证证据（逐项给命令与结果）

| 核对 | 命令 | 结果 |
| --- | --- | --- |
| 原页锚点 + 历法 + 日界 + 缺项 + 稳定性 | `node paipan/scripts/core-check.mjs` | **27/27 通过**。含：山水蒙逐爻六亲纳甲、离宫四世、世4应1、旬空戌亥、六神起例、伏神妻财己酉金@4（与阶段 2 原页转写一致）；自动历法 2006-05-10 14:22 → 己亥日/癸巳月/辛未时；2024-01-01 23:30 zi23=乙丑 vs midnight=甲子；缺历法时六神/旬空为 null 且有原因；同输入两次 canonical 完全相同 |
| 64 卦名全量比对 | `node paipan/scripts/names-check.mjs` | 与 `liuyao-skills`、`fortune-liuyao-skill` **各 64/64 零不一致** |
| 4096 组合结构不变量 | `node paipan/scripts/invariants.mjs` | **8/8 通过**：遍历 4096；本卦恰 64 种且各出现 64 次；八宫×8 阶段 64 类各 64 次；动爻分布 = C(6,k)·64（64/384/960/1280/960/384/64）；无违例（世应规则、变卦差异位数=动爻数、纳甲非空、六亲合法、庚戌日旬空=寅卯）；canonical 4096 种互不相同；顺序敏感（反序 → 水雷屯） |
| 两套上游同输入对照 | `node paipan/scripts/upstream-compare.mjs` | 山水蒙：两家与自研**逐爻一致** |
| 历法与边界探测 | `node paipan/scripts/calendar-probe.mjs`、`boundary-probe.mjs` | 原页锚点 9/9；独立实现 7/7（2 项为对方范围外）；立秋交接 2026-08-07 19:42:43；时区 ICU 行为 |

**证据等级**（任务书第 6 节要求不得混为一谈）：

- **原书原页核对**：农历 1997 八月初七=癸丑；公历 2006-05-10 14:22=丙戌/癸巳/己亥/辛未；公历 2003-12-25 09:30=癸未/甲子/壬申/乙巳；山水蒙卦盘六亲纳甲与宫世应。
- **独立实现对照**：64 卦名与 9 个日期日柱（不同作者的 `solarlunar`）。
- **领域规则推导**：六亲/六神/旬空/伏神算法（领域通行，由两家实现一致印证；未逐条追溯古籍版本）。
- **仅与某一上游自测一致**：动化回头生克与化进化退（本阶段只输出基础动变字段，未做吉凶解释）。
- **尚未核实**：`fortune-liuyao-skill` vendored `lunar_python` 的确切版本；`liuyao-skills` 一律时区路径；本阶段未逐条追溯古籍版本。

## 4. 与上游的差异表（不静默取其一）

| 字段/行为 | `liuyao-skills`（JS） | `fortune-liuyao-skill`（Python） | 本项目首版选择与理由 |
| --- | --- | --- | --- |
| 硬币约定 | 0=反/1=正，三背=9 老阳 | 正=3/反=2，三背=6 老阴 | **首版不实现硬币/随机起卦**，只收六个 6/7/8/9（避免不可复现输入与约定混淆） |
| 缺日柱/月建 | 静默降级（六神默认从青龙起、旬空给空串、`calendar:null` 仍成功） | 两参数必填，缺一即抛 | **一律 `null` + `unavailable` 原因**（任务书第 3 节禁止"看似完整的默认盘"） |
| 卦名粒度 | 短名（坤/屯/明夷） | 全名（坤为地/水雷屯/地火明夷） | 输出**全名**，同时保留编码；比对工具做粒度归一 |
| 伏神派生字段 | 仅 `hidden`/`hiddenCandidate` | 另有飞伏生克关系 | 首版只出伏神/飞神干支与六亲，派生关系留待阶段 4 |
| 日界 | `midnight`/`zi23` 显式（映射经本项目实测正确） | 默认 `zi_hour`，仅日柱 +1 天 | 采用显式口径，默认 `zi23`，盘面记录所用口径 |
| 时柱在晚子时的归属 | 未逐一验证 | 不受日界策略影响（库默认） | **未核实**，已列入第 6 节遗留项 |
| 历法运行环境 | 需要 Python 子进程（10 s 超时、1 MiB 上限） | 纯 Python + vendored 库 | **生产用 Node 自研适配（lunar-typescript）**，不引入 Python |

## 5. 启动与复跑

```bash
# 依赖（按 lockfile 重装；node_modules 不入库）
cd paipan && node <npm-cli> install          # 或 npm install

# 排盘（手动历法模式，不需要 Python、不需要网络）
node paipan/bin/paipan.ts --lines 8 7 8 8 8 7 --day 戊辰 --month 申
node paipan/bin/paipan.ts --lines 6 7 8 9 7 8 --canonical       # 缺历法 → 六神/旬空为 null 并附原因

# 排盘（自动历法模式，本版仅支持 Asia/Shanghai）
node paipan/bin/paipan.ts --lines 8 7 8 8 8 7 --at 2006-05-10T14:22:00 --timezone Asia/Shanghai --day-boundary zi23

# 核对
node paipan/scripts/core-check.mjs
node paipan/scripts/names-check.mjs          # 需要 storage/repos 下的两个上游快照（审查用，不入发布包）
node paipan/scripts/invariants.mjs
```

错误输入示例（均 exit 2 且带可识别 code）：`invalid_line_value`、`invalid_date`、`unsupported_timezone`、`missing_timezone`、`incomplete_manual_calendar`、`out_of_range`。

## 6. 迁移目录运行证据与未完成项

- **迁移验证**：把 `paipan/` 整体复制到项目 `storage/tmp/` 之外的临时目录后运行 CLI，输出与在项目内一致，且盘面 JSON 中不含任何 `E:`/`F:` 主机路径（见第 7 节命令与结果）。
- **未完成／未核实**：
  1. **未做**全量（4096 输入）×两家上游的逐字段差异扫描，只做了 64 卦名全量与山水蒙逐爻对照；扩展扫描留待复验或阶段 4。
  2. 晚子时**时柱**归属是否与两家一致，未核实。
  3. 原页锚点仅 3 例 9 项；样例集可继续扩充（本阶段覆盖了任务书第 6 节列出的静卦/老阴/老阳/多动爻/缺日月/两种日界/节气边界/非法值/无效日期）。
  4. `storage/repos`（上游快照）与 `storage/pylibs`（Python 对照环境）是**审查/对照用**，不进发布包；因此 `names-check.mjs` 在无快照的环境会跳过该部分比对。
  5. 本阶段未实现：用神选取、吉凶/应期/类象解读、真太阳时/地方时、随机起卦。

## 7. 迁移验证命令与结果（复跑记录）

```powershell
# 复制模块（含依赖）到项目外临时目录，再运行 CLI
$dst = "$env:TEMP\paipan-migrate-check"
Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -Recurse "E:\workspace-ai\xuanxue\liuyao\paipan" $dst
node "$dst\bin\paipan.ts" --lines 8 7 8 8 8 7 --day 戊辰 --month 申 --canonical
```

判定：输出与项目内一致；盘面 JSON 不含 `E:`/`F:` 路径；不访问网络、不调用 Python。

**实际结果（2026-10-04 执行）**：

```text
已复制到 C:\Users\...\AppData\Local\Temp\paipan-migrate-check
exit=0
本卦=山水蒙 宫=离宫四世 世4应1 旬空=戌亥
逐爻六亲纳甲: 父母戊寅木 子孙戊辰土 兄弟戊午火 子孙丙戌土 官鬼丙子水 父母丙寅木
盘面 JSON 中盘符路径出现次数: 0
与项目内运行结果一致: True
```

即：把 `paipan/` 整体复制到项目目录之外后，仅凭 Node（v22）+ 随包 `node_modules` 即可运行，结果与项目内完全一致、不含任何主机绝对路径。

## 8. 文件清单与哈希

- 本阶段新增/修改的受版本控制文件见 `git log --oneline` 中第三阶段的提交（`1ba9f12`、`fd7f428`、`bd0cbff`、`8e0098a` 及最后一次提交）。
- 上游快照的逐文件 SHA-256：`storage/repos/liuyao-skills-file-sha256.txt`（74 项）、`storage/repos/fortune-liuyao-skill-file-sha256.txt`（70 项）。
- 运行时依赖锁定：`paipan/package-lock.json`；唯一运行时依赖 `lunar-typescript@1.8.6`（MIT，零传递依赖）。
