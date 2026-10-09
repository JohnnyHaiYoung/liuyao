# 第三阶段独立验收：提交 `7a6ab8d`

日期：2026-10-05。依据：[第三阶段研发任务书](phase3_development_spec.md)。验收对象为 `18bcb3b..7a6ab8d` 的第三阶段交付。**结论：暂不通过，修复后复验。** 本报告只记录可复现的交付与软件行为；排盘规则一致不等于现实占断准确。

## 已验证的部分

- `core-check.mjs` **27/27**、`invariants.mjs` **8/8** 通过；4096 个爻值组合的结构不变量、64 卦覆盖、同输入稳定性均通过。`names-check.mjs` 对两家上游各 **64/64** 卦名一致。这些主要证明程序内部一致性和与上游一致性，不能单独证明传统规则正确。
- 新输入 `7 7 9 6 6 7`、戊戌日、亥月，得到山天大畜→天泽履，动爻 3/4/5，卦宫艮宫二世、世二应五；与固定快照 `liuyao-skills` 的同输入结果一致。
- 2026-08-07 立秋交接前后，月柱在 `19:42:42` 为乙未，在 `19:42:43` 为丙申；以 `TZ=UTC` 与 `TZ=America/New_York` 运行该样例，历法输出相同。无效公历日期 `2026-02-30` 返回 `invalid_date`。
- 这批提交没有修改阶段 1 的 `app/` 或阶段 2 的 `corpus/`、`wiki/`；未把排盘接入聊天。此项是版本差异检查，未重复进行阶段 1、2 的完整回归验收。

## 阻断项

### P1-1：命令行把非法或不完整输入当作有效输入

`paipan/bin/paipan.ts:84` 用 `Number.parseInt` 转换爻值，`7abc`、`7.5` 均被截为 `7`，命令返回成功，盘面回显合法 `7`，原始错误输入消失。`--at` 没有值时被解析为布尔值，`typeof at === 'string'` 不成立，最后以 `calendar:null` 成功返回；同时提供 `--at` 与 `--day/--month` 时，手动输入被静默忽略。违反任务书第 3、4 节对非法值、历法模式和原始输入可追溯的约束。

复现：

```text
node paipan/bin/paipan.ts --lines 7abc 7 7 7 7 7 --day 甲子 --month 寅 --canonical
→ 成功，input.lineValues[0]=7
node paipan/bin/paipan.ts --lines 7 7 7 7 7 7 --at --timezone Asia/Shanghai --canonical
→ 成功，calendar=null
node paipan/bin/paipan.ts --lines 7 7 7 7 7 7 --at 2024-02-08T12:00:00 --timezone Asia/Shanghai --day 甲子 --month 寅 --canonical
→ 成功，自动历法覆盖手动日柱；未提示模式冲突
```

修复门槛：原始爻值只接受字符串 `6/7/8/9`；缺参数值、重复或冲突模式给出明确错误；保留并回显输入来源；补上述反例。

### P1-2：手动模式接受不可能的日柱，并生成伪造的旬空

`paipan/src/calendar.ts:116` 只检查干、支各自属于字符集，没有检查 60 甲子合法配对。`--day 甲丑` 成功输出 `dayGanzhi=甲丑`、旬空 `亥/子` 及六神。甲为阳干、丑为阴支，该组合不是六十甲子之一。即使日柱由外部提供，也必须拒绝这种不可能的值，不能用它继续计算。

复现：`node paipan/bin/paipan.ts --lines 7 7 7 7 7 7 --day 甲丑 --month 寅 --canonical`。

修复门槛：按六十甲子集合校验；无效日柱返回 `invalid_day_ganzhi`，不产生完整盘面。

### P1-3：节气窗口证据在交接前已提前跳转

`paipan/src/calendar.ts:107` 用 `getPrevJieQi(true)` / `getNextJieQi(true)` 记录前后节气。独立复算：2026-08-07 `00:30:00` 和 `19:42:42` 的月柱仍为乙未，交接点是 `19:42:43`，但两次 JSON 均写 `solarTermWindow.previous=立秋, next=处暑`；前一日 `23:30:00` 则写 `previous=大暑, next=立秋`。交接前的窗口标签与实际时刻不符，使盘面的节气证据不可追溯。月柱本身在这组边界正确。

修复门槛：窗口按**时刻**判断，最好连同节气名称输出对应的当地交接时间；在交接前一秒、交接秒和交接后一秒核对。

### P1-4：发布与依赖契约不一致，迁移证明不足

`paipan/package.json:8-10` 与锁文件把 `solarlunar@3.1.0` 列为**生产依赖**；在 `paipan/` 执行 `npm ls --omit=dev --depth=0 --json` 也列出它。`docs/phase3_delivery.md:118`、`docs/phase3_calendar_decision.md` 和 `paipan/THIRD_PARTY_LICENSES.md` 却称唯一运行时依赖是 `lunar-typescript`。此外 `paipan/.npmrc:1` 把 npm 缓存固定到本机 `E:\workspace-ai\xuanxue\liuyao\storage\tmp\npm-cache`；迁移验收只复制了带 `node_modules` 的目录运行，没有在新目录依锁文件重装。`package.json:7` 声明 `node >=22.0.0`，但当前交付直接运行 `.ts`；Node 官方文档显示内建类型剥离在 v22.6.0 才加入，v22.18.0 才默认开启（[Node v22.21 文档](https://nodejs.org/download/release/v22.21.0/docs/api/typescript.html)）。因此声明的最低版本不足以保证交付命令可运行。

修复门槛：把对照库移入开发依赖或如实列为生产依赖；移除机位绝对缓存路径；明确 Node 最低可运行版本或提供编译后的 JS；在脱离项目路径的新目录用声明的安装方式重建依赖并运行，记录真实文件清单与哈希。

## 需同步修正的证据与文档

1. **原书第 20 页内部矛盾**：`corpus/figures/src-e6fc8612e955/page-020.md` 对山天大畜标“世初、应四”；同页正文却写“世爻官鬼寅木”（二爻）、“应爻子水动”（五爻）。原页图也确实如此。项目输出和 `liuyao-skills` 都是世二、应五；不能把图中标签当成无争议金标准，应在规则口径的差异表中登记，说明采用理由，不擅自改写原件。
2. **历法年柱口径未声明**：2024-02-08 12:00（立春后、农历新年前）输出 `yearGanzhi=癸卯`、`monthGanzhi=丙寅`。同一历法库的节令年 API `getYearInGanZhiExact()` 为甲辰。当前使用的是农历年与节令月的混合字段；这未必违反六爻排盘口径，但必须分别命名/解释，不应被误读为同一四柱体系。
3. **交付文档不齐**：任务书第 7 节要求的 `docs/phase3_rule_profile.md` 缺失；交付说明以机器可读 JSON 代替，但没有人读版集中说明来源定位、默认选择与未核实点。`docs/phase3_delivery.md` 的“文件清单与哈希”只指向 Git 提交和上游快照哈希，未列本阶段模块/发布内容的实际清单及 SHA-256。
4. **上游对照脚本输出不能直接当逐字段一致证据**：本次运行 `paipan/scripts/upstream-compare.mjs`，JS 行的阴阳为 `undefined`、六亲为空，Python 行在 Windows 终端出现乱码。脚本仍退出成功；应修复字段映射与输出编码，并让解析失败/关键字段缺失时非零退出。当前 64 卦名对照仍可采信，逐爻对照强度需要重新确认。

## 复验条件与最终结果

研发方修复四项 P1，并补齐证据/文档后，提交固定 SHA 与可复制的复验命令。复验至少覆盖上述反例、节气交接前后、干支合法集合、两种日界、新目录依锁文件安装和原书第 20 页冲突记录。

**最终结果：第三阶段暂不通过；现有成果可作为继续修复的基础，尚不能作为可移植、可追溯的排盘模块签收。**
