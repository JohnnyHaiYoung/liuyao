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
# ── 运行环境 ──
# Node ≥ 22.18.0（本模块直接交付 TypeScript，依赖 Node 内建类型剥离；v22.6.0 引入、v22.18.0 起默认开启）。
# 若使用 22.6.0–22.17.x，需显式加 --experimental-strip-types；低于 22.6.0 请改用编译后的 JS（本版未提供）。

# ── 安装（按锁文件；生产只需要 lunar-typescript） ──
cd paipan
npm ci --omit=dev        # 生产依赖：仅 lunar-typescript@1.8.6（零传递依赖）
npm ci                   # 若要跑开发期对照脚本（names-check / calendar-probe），需连同 devDependencies（solarlunar）

# ── 排盘（手动历法模式，不需要 Python、不需要网络） ──
node bin/paipan.ts --lines 8 7 8 8 8 7 --day 戊辰 --month 申
node bin/paipan.ts --lines 6 7 8 9 7 8 --canonical       # 缺历法 → 六神/旬空为 null 并附原因

# ── 排盘（自动历法模式，本版仅支持 Asia/Shanghai） ──
node bin/paipan.ts --lines 8 7 8 8 8 7 --at 2006-05-10T14:22:00 --timezone Asia/Shanghai --day-boundary zi23

# ── 核对 ──
node scripts/core-check.mjs      # 27/27：原页锚点、历法、日界、缺项、稳定性
node scripts/invariants.mjs      # 8/8：4096 组合结构不变量
node scripts/regression.mjs      # 25/25：验收反例（非法输入、六十甲子、节气交接、年柱口径）
node scripts/names-check.mjs     # 64/64：需 storage/repos 下的两个上游快照（审查用，不入发布包）
```

错误输入示例（均 exit 2 且带可识别 code）：`invalid_line_value`、`missing_option_value`、`duplicate_option`、`unknown_option`、`unexpected_argument`、`conflicting_calendar_mode`、`invalid_day_ganzhi`、`invalid_date`、`unsupported_timezone`、`missing_timezone`、`incomplete_manual_calendar`、`out_of_range`。

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

## 8. 发布内容清单与 SHA-256

本阶段受版本控制的模块文件（15 项；`node_modules` 不入库，按 `package-lock.json` 重装）：

| 文件 | SHA-256 |
| --- | --- |
| `paipan/.npmrc` | `171c76ccf91915dd0a758a4c479fe62d9f71aec13597648ef2ad4abcaf2ca623` |
| `paipan/THIRD_PARTY_LICENSES.md` | `669258920b85f7e52c6a70e866641d8bcc0efb4988541571bcfac5faaef3d839` |
| `paipan/bin/paipan.ts` | `2816dba13c38b9a91fffbdeae1e79512a0670ee3de371f4cfb879bc12ca27079` |
| `paipan/package-lock.json` | `7b63f3553d2d0ffb122ef2169a9de10aff0a8fa3deaa8968155cd9cd3b208b08` |
| `paipan/package.json` | `2b48df4e371210d877bdcf3144c02ed1002124d98e6af1f5823631401c6f97c6` |
| `paipan/rules/rule-profile.v1.json` | `23ce91703a0a7630737c2418252d884e59184ef366f119743187a42fe41d3223` |
| `paipan/scripts/boundary-probe.mjs` | `5709a7b52f577df84f9702737876d4e1fa02c9078166de4d9140184d36c4438c` |
| `paipan/scripts/calendar-probe.mjs` | `c69673ab7991cbe68f85423a8d16022910936157358aceeea6e9db8e1e813135` |
| `paipan/scripts/core-check.mjs` | `ff9eb3f66712274f169143c741bfbcb31e6e11ac83a229e7cabe025a4640e357` |
| `paipan/scripts/invariants.mjs` | `749e380e166b4072d5445553f91ccd4228295f005d7a077fcfc7ef3876bbe70a` |
| `paipan/scripts/names-check.mjs` | `c733cd7ced55efa198ba234085d8327944f05b494e9f23faa0ecd3bf1b5dc638` |
| `paipan/scripts/regression.mjs` | （随提交更新） |
| `paipan/scripts/upstream-compare.mjs` | `ceeac69592165f5b471620a55a83147e5f3106946c77d5d02003a70c04fbfd58` |
| `paipan/src/calendar.ts` | `17b0f34cfcfd71f2c93611ae01b965f5bb3424163b03f9bc02c50f73df20570b` |
| `paipan/src/core.ts` | `04d309a06935660c15445b8e87a83f36e469a27eb2bd42466f7c6608c9f2083d` |
| `paipan/src/rules.ts` | `49b82d1f4bb8034c867c5775d966eca2756eb506bd2323480d10c4b2e3b2a4bf` |

- 运行时依赖锁定：`paipan/package-lock.json`（生产仅 `lunar-typescript@1.8.6`；`solarlunar@3.1.0` 为 devDependency）。
- 上游快照逐文件哈希（审查用，不入发布包）：`storage/repos/liuyao-skills-file-sha256.txt`（74 项）、`storage/repos/fortune-liuyao-skill-file-sha256.txt`（70 项）。

## 9. 针对验收报告（`7a6ab8d`）四项 P1 与四项证据问题的修复

| 项 | 原因 | 修复 | 复验证据 |
| --- | --- | --- | --- |
| P1-1 非法/不完整输入被当作有效 | `--lines` 用 `Number.parseInt`（`7abc`、`7.5` 被截成 7）；缺值参数解析成布尔；`--at` 与手动模式并存时静默覆盖 | 爻值只接受字符串 `6/7/8/9`；新增 `missing_option_value`、`duplicate_option`、`unknown_option`、`unexpected_argument`、`conflicting_calendar_mode`；原始爻值原样回显 `input.rawLineValues`，历法来源写入 `calendar.source` | `node paipan/scripts/regression.mjs` → 相关 11 项通过（含 `7abc`、`7.5`、缺 `--at` 值、重复 `--at`、`--at` 与 `--day/--month` 冲突、手动模式带 `--timezone`） |
| P1-2 手动模式接受不可能的日柱 | 只校验干、支字符集，未校验六十甲子配对 | 新增 `isSexagenary()`（干支索引同奇偶），非法日柱返回 `invalid_day_ganzhi` 且不产生盘面 | 回归中「甲丑/乙子 非法、戊辰 合法、六十甲子恰 60 个、`--day 甲丑` exit 2 且无 `voidBranches`」全部通过 |
| P1-3 节气窗口提前跳转 | 用了按天口径 `getPrevJieQi(true)` | 改用按时刻口径 `getPrevJieQi(false)/getNextJieQi(false)`，并输出当地交接时间 `previousAt/nextAt` | 回归中 2026-08-07 `19:42:42` → 前=大暑/后=立秋、`19:42:43` → 前=立秋/后=处暑、前一日 → 大暑/立秋，且月柱在交接秒才由乙未变丙申 |
| P1-4 发布与依赖契约不一致 | `solarlunar` 被列为生产依赖；`.npmrc` 写死本机缓存路径；engines 声明 `>=22.0.0` 但交付 `.ts` | `solarlunar` 移入 devDependencies；`.npmrc` 只留 registry；engines 改为 `>=22.18.0` 并在第 5 节说明 22.6–22.17 需 `--experimental-strip-types` | `npm ls --omit=dev --depth=0` → 仅 `lunar-typescript@1.8.6`；**新目录只复制源码/配置/锁文件后用 `npm ci --omit=dev` 重装**（added 1 package，node_modules 79 个文件）→ CLI 正常、回归 25/25、盘面 JSON 零主机盘符路径 |
| 证据项 1 原书第 20 页内部矛盾 | 卦盘图标注「世初应四」，同页正文写「世爻官鬼寅木」（二爻）与「应爻子水动」（五爻） | 在规则口径第 5 节与 `rule-profile.v1.json` 的 `differences.corpusInternalConflicts` 登记冲突，说明本项目采用世二应五（与正文及八宫规则一致），**不改写原件**，该页维持 `needs_review` | 见 `docs/phase3_rule_profile.md` 第 5 节 |
| 证据项 2 年柱口径未声明 | `yearGanzhi` 用农历年、`monthGanzhi` 用节令月，混在一起像同一体系 | 拆成 `yearGanzhi`（农历年）与 `yearGanzhiByLiChun`（立春换年），并在规则口径第 2、6 节标注"哪一种是六爻通行口径未核实" | 回归中 2024-02-08 12:00 → 癸卯 / 甲辰 / 丙寅 三项分列通过 |
| 证据项 3 缺人读版规则说明 | 任务书第 7.2 节要求的 `docs/phase3_rule_profile.md` 缺失 | 新增该文件（字段定义、来源定位、默认选择、差异表、第 20 页冲突、未核实清单） | 文件已提交；本文件第 8 节给出实际清单与 SHA-256 |
| 证据项 4 上游对照脚本不能当逐字段证据 | JS 行阴阳 `undefined`、六亲空；Python 输出乱码；解析失败仍退出 0 | 按两侧真实结构做字段归一（`isYang`/`text`/六亲候选名）；Python 强制 `PYTHONIOENCODING=utf-8`；解析失败或关键字段缺失时**非零退出**并打印原因 | `node paipan/scripts/upstream-compare.mjs` → 两侧均解析成功、字段齐全时退出 0；缺字段/解析失败时退出 1 并列出问题 |
