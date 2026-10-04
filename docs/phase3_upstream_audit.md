# 第三阶段上游 Skill 审查报告

版本：2026-10-04。审查对象为任务书第 2 节指定的两个候选仓库，**以下载后的固定提交为准**（不跟随浮动 `main`）。本报告区分三种证据等级，逐条标注：

- **[自核]** 本项目在本机亲自运行/读码核实；
- **[子代理]** 由隔离审查子代理读码得出，附 `文件:行号`，本项目未逐行复核；
- **[未核实]** 无法从代码确认，或缺少独立依据。

## 1. 快照、来源与完整性

| 项目 | liuyao-skills | fortune-liuyao-skill |
| --- | --- | --- |
| 来源 URL | `https://github.com/songgoldenwind-crypto/liuyao-skills` | `https://github.com/shubhaviatiningsih-byte/fortune-liuyao-skill` |
| 固定提交（完整 SHA） | `d3f4575d449c0872aac23a04fbd80e5f690506e6` | `3aedfd97a5355819edd574e1942ab05170ef8578` |
| 获取方式与日期 | `git clone` 经本地代理 + OpenSSL 后端，2026-10-04 | 同左，2026-10-04 |
| 快照位置（隔离） | `storage/repos/liuyao-skills`（74 个受控文件，约 494 KB） | `storage/repos/fortune-liuyao-skill`（70 个受控文件，约 3.3 MB） |
| 逐文件 SHA-256 清单 | `storage/repos/liuyao-skills-file-sha256.txt` | `storage/repos/fortune-liuyao-skill-file-sha256.txt` |
| 工作树状态 | 干净，`HEAD` 与目标提交一致 [自核] | 干净，`HEAD` 与目标提交一致 [自核] |

获取命令（可复跑；`--proxy`/`sslBackend` 为本机网络条件所需，不写入任何脚本）：

```bash
git -c http.proxy=http://127.0.0.1:7897 -c http.sslBackend=openssl clone <仓库 URL> storage/repos/<名字>
```

> 快照只用于审查，**不进入生产依赖**；本报告不代表已采用其中任何代码（采用决定见第 5 节）。

## 2. 许可证与依赖

| 项目 | liuyao-skills | fortune-liuyao-skill |
| --- | --- | --- |
| 仓库许可 | MIT；根 `LICENSE` 与 `liuyao-paipan-code/LICENSE` 内容一致，`Copyright (c) 2026 songgoldenwind-crypto` [子代理] | **Apache-2.0 模板**，但 `LICENSE:190` 仍是 `Copyright [yyyy] [name of copyright owner]`，全仓无 NOTICE / 无署名 → **实际权利人无法确认** [子代理] |
| 运行时依赖 | JS：`express ^5.2.1`、`opencc-js ^1.4.2`、`vue ^3.5.30`（devDep 仅 `@vue/compiler-sfc`）；Python：`requirements.txt` = `lunar-python==1.4.8`（精确 pin，21 字节）[自核] | 无外部 Python 包；`requirements.txt` 只有两行注释，**不是可安装清单**；`vendor/lunar_python/` 为**源码内联**（33 个 `.py`，含 `util/LunarUtil.py` 110 KB）[子代理] |
| 生命周期脚本 | `package.json` 只有 test/paipan/server/manifest:update，**无 postinstall/preinstall/prepare** [子代理] | 无 |
| 传递许可 | — | `vendor/lunar_python-LICENSE` = MIT，`Copyright (c) 2020 6tail` → 来源可确认为上游 6tail/lunar-python；但 vendor 内**无 `__version__`**，"1.4.8" 仅见于 `requirements.txt:2`、`liuyao_core.py:125` [子代理] |
| 版本自证 | Python 依赖 pin 可核（本项目已装同版本 `lunar_python 1.4.8`）[自核] | **无法自证**：vendor 版本仅凭自称 [未核实] |

## 3. 行为审查

### 3.1 输入契约（两仓库一致的部分）

| 项目 | 结论 |
| --- | --- |
| 爻值集合 | 恰好 6 个、且每个 ∈ {6,7,8,9}；非法值抛错。liuyao-skills：`inputValidation.js:1`、`:70-79`；fortune：`liuyao_core.py:93-97` [子代理] |
| 顺序 | **初爻在前**。liuyao-skills：`liuyaoDetail.js:368-370`、`:380`；fortune：`liuyao_core.py:474` `order='bottom_up'` [子代理] |
| 硬币约定 | 两家不同但各自内部一致：liuyao-skills 0=反/1=正、值=和+6（三背=9、三面=6）；fortune 正=3/反=2、三背 6 动/三面 9 动。**两者符号相反**（"三背"在一家是 9、另一家是 6）→ 对照时必须按各自约定换算，不能直接比对 [子代理] |
| 随机起卦 | fortune 用 `secrets.randbits(1)`、**无种子、不可复现**（`cast_lines.py:33`）→ 对照实验必须走 `--method lines/coins`；liuyao-skills 用 `crypto.getRandomValues` 且仅在前端 composable [子代理] |

### 3.2 排盘核心的形态（决定能否在 Node 复用）

- **liuyao-skills [子代理]**：`src/data/hexagrams.js` 只是 64 卦的文字数据（卦名、卦辞、爻辞等），**不含**纳甲/六亲/世应/八宫/伏神/旬空；这些全部在 `src/utils/liuyaoDetail.js`（424 行，纯 ESM、零浏览器依赖）里算出来：八宫与世应由位翻转生成（`:146-183`）、纳甲查内置表（`:45-78`）、六亲由五行生克推（`:202-232`）、六神由日干推（`:234-238`）、伏神比对纯卦（`:271-283`）、旬空由日柱推（`:289-305`）。入口签名 `buildLiuyaoDetail({yaoValues,currentHexagram,changedHexagram,calendar,hexagramData})`，失败一律 `return null`（`:331-349`）。
- **fortune-liuyao-skill [子代理]**：`scripts/liuyao_core.py`（478 行）同样以查表 + 确定性计算为主（`TRIGRAMS:24`、`HEXAGRAM_NAMES:31`、`NAJIA:42`、`PALACE_PATTERNS:62`、`GENERATES:57`/`CONTROLS:58`、`SIX_SPIRITS:59`），并额外输出月破/日冲、动变回头生克、冲合害刑、三合成局、应期候选。子代理实测"64 卦恰好 8×8 分宫、无遗漏"。
- 两家的**世应、旬空、伏神算法都是各自实现**，不是共享库 → 可用于交叉比对，但"一致"只说明实现相同/相近，不说明规则正确。

### 3.3 历法路径（本阶段的关键判断）

| 项目 | liuyao-skills | fortune-liuyao-skill |
| --- | --- | --- |
| 历法来源 | 子进程调用 Python + `lunar_python`（`server/python/divination_context.py:6`）[子代理] | 内置 vendor 的 `lunar_python`，**同一上游库**（`liuyao_core.py:102`）[子代理] |
| Python 是否必需 | **否**：CLI 提供 `--day/--month` 直供路径即可离线出盘（子代理已实跑成功；本项目另见第 4 节）[子代理] | **是**（核心即 Python） |
| 子进程行为 | `spawn(bin,[scriptPath])`、JSON 走 stdin、超时 10 s→SIGKILL、输出上限 1 MiB、取 stdout 最后一行 JSON；解释器候选 `LIUYAO_PYTHON > PYTHON_BIN > /opt/miniconda3/bin/python3 > python3`；**无网络** [子代理] | 无子进程、无网络 [子代理] |
| 日界 | `divination_context.py:58-62`：`zi23 → getDayInGanZhiExact()`、`midnight → getDayInGanZhiExact2()`。**本项目实测复核：该映射正确**（见 §4）[自核] | 显式策略参数，默认 `zi_hour`：`liuyao_core.py:105` 仅当 23 点后**日柱 +1 天**，月建/节气窗口不受影响；实测 23:30 两策略日柱不同、22:30 与 00:30 一致 [子代理] |
| 月建/节气 | `getMonthInGanZhiExact()` 按节气交接时刻；`monthBranch = 月柱末字`（`:84`）[子代理] | `getMonthZhi()` 按节令（非农历月）；实测 2026-08-04（大暑后立秋前）→ 月建未、节窗 大暑 07-23 / 立秋 08-07 [子代理] |
| 时区 | CLI 层接受 `--at`（需 Python）；未验证其 IANA 时区处理 [未核实] | 接受 tzinfo；`run_liuyao.py:31-37` 对 `Asia/Shanghai` 有固定 UTC+8 回退，`build_chart.py:37` **无**回退（缺 tzdata 直接抛）[子代理] |

### 3.4 缺项、异常与副作用

| 项目 | liuyao-skills | fortune-liuyao-skill |
| --- | --- | --- |
| 缺日柱/月建 | **静默降级**：日干日支空串 → 六神默认从青龙起（`liuyaoDetail.js:235`）、贵人/日禄/驿马/桃花为空串、旬空空串；`calendar:null` 仍 exit 0。**与本项目任务书第 3 节"缺项必须 `unavailable`/`null` 并附原因"不符** [子代理] | 两个参数**必填**，缺即 `TypeError`；CLI 强制"同给或同不给"，只给一个 → `ValueError`（`build_chart.py:44-50`）；两者都给则跳过历法并标 `calendarLibrary: "externally_verified"` [子代理] |
| 非法输入 | CLI stderr + exit 2；HTTP 400 [子代理] | `ValueError`；无效日期不捕获（实测 `2026-02-30` → `day is out of range for month`）[子代理] |
| 写盘副作用 | 无（库函数纯计算）[子代理] | 多数脚本需显式 `--output`；**`run_liuyao.py` 例外**：只要 `artifact_dir` 非空即 mkdir 并写 HTML+Markdown，**默认回退到 `Path.cwd()`**（`:109-115`、`:212`）→ 调用时必须显式约束目录 [子代理] |
| 网络 | 无 [子代理] | 无 [子代理] |

### 3.5 分发与安装风险

- **存在一键写入用户全局目录的脚本**：`liuyao-skills/scripts/install.py:19-30` 会写 `~/.claude/skills`、`~/.agents/skills`、`~/.cursor/skills` 等九个目录，`--scope user` 为默认（`:60-62`）。**本项目不执行该脚本**（任务书第 2.1 节明令）。[子代理]
- `.agents/plugins/marketplace.json:9-17` 指向远端 `ref: main`（**非固定 commit**）→ 上游安装路径不可复现；本项目一律按固定 SHA 取快照。[子代理]
- `MANIFEST.json`（32 条 `{file,bytes,sha256}`）+ `scripts/update-manifest.mjs:37-44` 确有哈希校验，**可复用其"固定版本记录"思路**；但 `tests/manifest.mjs:11`、`:40` 以 LF 字节数为基线，在 CRLF 工作树必然失败（`npm test` 直接 red）[子代理]
- fortune 的 `agents/openai.yaml:1-10` 是 OpenAI/Codex 型 Skill 清单（`allow_implicit_invocation: true`），**无 MCP/HTTP 端点/Dockerfile** → 不是可部署服务。[子代理]
- fortune 的 `classify_sensitive.py` 为排盘前的**子串匹配**合规分流；子代理实测可绕过（"自杀怎么办""大出血怎么办"均放行），且比 `references/safety-boundaries.md:8-13` 的词表更窄 → **文档与实现不一致**。[子代理]

## 4. 本项目自行复核的两项

### 4.1 日界映射：子代理判"颠倒"，本项目实测**不成立**

代码原文（`server/python/divination_context.py`）：

```python
 58:     day_ganzhi = (
 59:         lunar.getDayInGanZhiExact()
 60:         if day_boundary == 'zi23'
 61:         else lunar.getDayInGanZhiExact2()
 62:     )
```

本项目用已安装的 `lunar_python 1.4.8` 实测（`storage/pylibs`）：

```text
晚子时 2024-01-01 23:30 | Exact=乙丑（=次日） | Exact2=甲子（=当日）
次日凌晨 2024-01-02 00:30 | Exact=乙丑          | Exact2=乙丑
当日午时 2024-01-01 12:00 | Exact=甲子          | Exact2=甲子
```

结论：`Exact` = 晚子时算明天（23:00 换日），`Exact2` = 晚子时算当天（00:00 换日）；代码把 `zi23 → Exact`、`midnight → Exact2`，**语义正确**。子代理的 R1 属误报（其自身也把该结论列入"未端到端验证"），**不作为缺陷记录**。

> 记录这条的意义：审查结论必须回到原始证据。本项目后续凡采用子代理/上游结论，均标注证据等级或自行复核。

### 4.2 原书原页的历法锚点（可用于验收的独立依据）

阶段 2 包内那本 PDF 的**原页**印着"1997 年六月初五…八月初七（**癸丑**）日难过"。本项目实测：

```text
农历 1997 六月初五 -> 公历 1997-07-09 | 日柱=壬子 | 月建=丁未 | 年柱=丁丑
农历 1997 八月初七 -> 公历 1997-09-08 | 日柱=癸丑 | 月建=己酉 | 年柱=丁丑   ← 与原页「癸丑」一致
```

这属于**原书原页核对**等级的证据，可用于验历法实现，而不必依赖"同一库自证"。

## 5. 复用范围与弃用理由（本项目决定）

| 对象 | 决定 | 理由 |
| --- | --- | --- |
| `liuyao-skills/liuyao-paipan-code/src/utils/inputValidation.js` | **可复用（候选）** | 纯 JS、零依赖、恰好 6 个 6/7/8/9 且报错文案明确初爻在上；仍需按本项目契约改写为 TypeScript 并补 `unavailable` 语义 |
| `liuyao-skills/liuyao-paipan-code/src/utils/liuyaoDetail.js` + `src/data/hexagrams.js` | **可复用（候选，需移植与核对）** | 排盘事实为纯计算/查表，可在 Node 进程内复用；但纳甲/六亲/世应/伏神/旬空的学理正确性**不能靠上游自测**，须按本项目规则口径文件逐项登记来源与差异 |
| `liuyao-skills/MANIFEST.json` + `scripts/update-manifest.mjs` | **思路可借鉴** | 提供"固定版本 + 逐文件 sha256/字节数"的记录方式；本项目已有 `storage/repos/*-file-sha256.txt` 与 pack 机制 |
| `liuyao-skills/server/**`（含 Python 桥接）、`scripts/paipan.mjs` 的 `--at` 路径 | **不采用** | 引入 Python 子进程，违反"生产链路以 Node 为主、不预设 Python 运行时"；其能力用本项目自研历法替代 |
| `liuyao-skills/src/composables/useDivination.js`、`HexagramChart.vue` | **不采用** | 依赖 Vue/浏览器环境，与 Node 服务无关 |
| `liuyao-skills/scripts/install.py` 与任何 Agent 插件清单 | **不采用、不执行** | 会写入用户全局 Skill 目录；任务书明令禁止 |
| `fortune-liuyao-skill/scripts/liuyao_core.py`（含 vendored `lunar_python`） | **仅作离线对照实现** | Python 核心，与 Node 部署目标不符；且仓库 LICENSE 未具名、vendor 版本无法自证 → 不作生产依赖。给定爻值与日月干支时无副作用，可只读调用做同输入对照 |
| `fortune-liuyao-skill/run_liuyao.py` | **不采用** | 默认把 HTML/Markdown 写到 `Path.cwd()`，副作用不可接受 |
| 两仓库自带的 tests / CI 结论 | **不作为证据** | 任务书第 2.2 节：上游测试只作线索；本项目重新执行并核对核心样例 |

## 6. 两套解读方法的方法边界（任务书第 2.5 节要求单列，不得混成"权威算法"）

| 项目 | `skills/liuyao/SKILL.md` | `skills/liuyao-divination/SKILL.md` |
| --- | --- | --- |
| 自述定位 | 分层断卦：取用、作用资格与先后顺序；日辰最高裁决、原月令定旺衰 [子代理] | 六爻测算：以**世爻为用神人**、双原、病药为主线，含市场/流分/择时专题 [子代理] |
| 明确排除 | 不用耗泄、不引入全局调平/双原/流时重定吉凶；**不混用另一套规则**，要求"分开呈现两套推演"（`liuyao/SKILL.md:34`）[子代理] | 声明不用于八字/紫微/塔罗（`:3`）[子代理] |
| 共同约束 | 均要求初爻至上爻、核盘纳甲/六亲/世应/伏神/旬空；均禁止把卦象写成已证实事实 [子代理] | 同左 |

**本项目处置**：两套方法登记为**并列的解读流派**，各自记录其规则前提与禁用项；本项目排盘核心只输出双方共同承认的**确定性盘面字段**（卦、宫、世应、纳甲、六亲、六神、伏神、旬空），不实现任何一方的吉凶推断。

## 7. 未核实清单（随交付继续跟进）

1. `fortune-liuyao-skill` 根 LICENSE 的真实权利人（模板未填写）[未核实]。
2. vendored `lunar_python` 是否确为上游 1.4.8（包内无版本常量；须与上游逐字节比对，需要联网或上游 tarball）[未核实]。
3. 纳甲/六亲/世应/六神表的**学理正确性**：两家实现一致只能说明实现一致；本项目将按规则口径文件逐字段标注来源等级 [待办]。
4. 六冲/六合卦集合、领域用神映射、应期口径的流派归属与出处（fortune 的 `domain-methods.json:2-6` 自认 `provenance=project_synthesis`、"不是古籍逐字引文"）[未核实]。
5. `liuyao-skills` 的 `--at` 路径对 IANA 时区与跨时区的实际表现 [未核实，本阶段不采用该路径]。
6. 两仓库在 `Asia/Shanghai` 之外的时区、23:00/00:00 边界、节气交接前后的完整行为 [待本项目用自研历法 + 原书样例逐项核对]。

## 8. 审查用到的命令（可复跑）

```bash
# 1) 取固定快照（经代理 + OpenSSL 后端）
git -c http.proxy=http://127.0.0.1:7897 -c http.sslBackend=openssl clone <URL> storage/repos/<名字>
git -C storage/repos/<名字> rev-parse HEAD

# 2) 逐文件哈希（已生成，可重新生成比对）
#    storage/repos/liuyao-skills-file-sha256.txt
#    storage/repos/fortune-liuyao-skill-file-sha256.txt

# 3) Python 侧对照环境（开发期，不入生产依赖）
E:\python\Python312\python.exe -m pip install lunar_python --no-deps --target storage/pylibs --proxy http://127.0.0.1:7897
```
