# 第四阶段独立复验报告（`83be120`，2026-10-08）

验收基线：HEAD `83be120`。对照 `docs/phase4_development_spec.md` 和上轮报告 `docs/phase4_reacceptance_49c1292_2026-10-07.md`。本轮未修改产品代码，未调用真实 DeepSeek 或千问 API。

## 结论

**第四阶段暂不签收。** 上轮两类 P1 的五个样例均已修复；本轮发现旧盘追问的新回退：已有盘面时，用户问“这卦怎么看 / 怎么解读 / 如何分析”等具体卦问题，服务端既不读取旧盘快照，也不发 `follow_up` 盘面事件。该场景属于任务书规定的旧盘追问主流程。

## 本轮检查

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 退出码 0；仍有 20 条动态文件追踪提示，发布包核验按约定留阶段 5 |
| `npm run typecheck` | 退出码 0 |
| `node tools/corpus-cli.ts verify` | 108 通过、0 警告、0 失败 |
| `npm run check:all -- --with-http --with-ui` | **11/11，退出码 0**；编排 92/92、端到端 65/65、阶段 1 HTTP 8/8、浏览器 2/2。输出留在 `storage/tmp/phase4-checkall-83be120.log` |
| 上轮 P1 样例 | 三条“新卦后看这卦”均进入 `chart` 缺项追问；两条方法问法均正常作答 |

## P1：方法问法规则吞掉当前盘追问

独立以 `currentChartRunId=old-run-123` 调用当前 `planTurn()`：

| 用户问法 | 实际 `intent/chartAction` | 应有 |
| --- | --- | --- |
| `这卦怎么看` | `general/none` | `chart_follow_up/follow_up`，绑定 `old-run-123` |
| `这个卦怎么解读` | `general/none` | 同上 |
| `这盘如何分析` | `source_comparison/none` | 同上 |
| `这卦怎么看事业` | `general/none` | 同上 |
| `这卦怎么断` | `general/none` | 同上 |
| `那这卦的应期如何判断` | `source_comparison/none` | 同上 |
| `这盘如何解读工作` | `general/none` | 同上 |
| `刚才那卦怎么理解` | `general/none` | 同上 |

对照 `那这卦的应期呢？` 仍正确返回 `chart_follow_up/follow_up`。因此问题与旧盘存储无关，而是措辞改变了意图路线。无旧盘时再测 `这卦怎么看` 和 `那这卦的应期如何判断`，结果分别为 `general/none`、`source_comparison/none`，`missingInputs=[]`，本地澄清为空；用户也不会被提醒当前没有盘面。

原因可定位到 `app/src/server/chat/planner.ts`：`HOW_TO_PATTERN` 将“怎么看 / 如何分析 / 怎么解读”当作通用方法问法，`isHowToQuestion` 随即否决旧盘追问分支。特别是“怎么理解”会被新加的单字“解”匹配。`app/src/server/chat/stream-service.ts` 只有在 `chartAction === 'follow_up'` 时才读取并注入旧盘快照、生成旧盘事件；这些结果为 `none`，因此模型得不到规范盘面 JSON，历史消息也不会绑定本次旧盘。

研发新增的 `app/scripts/check-orchestration.mjs` 把 `这卦怎么看` 放入“纯知识/无关问题”组，只断言“不附加缺项澄清”，没有验证应沿用旧盘。这项断言不能证明该场景正确。

**修复门槛：**识别指向当前盘的“这卦 / 这个卦 / 这盘 / 刚才那卦”与“怎么断 / 怎么看 / 如何分析”等组合时，优先沿用已保存的盘面；没有旧盘时询问用户提供盘面或澄清，不把它当成脱离盘面的泛知识问题。保持“如何学会断卦 / 起卦后怎么断卦”等一般方法问题正常回答。增加计划层和消息层回归，核 `chart` 事件 `action=follow_up`、同一 `chartRunId`、规范盘面进入上下文，以及历史绑定。

## 证据边界与遗留

本轮构建、资料及现有检查通过不代表未覆盖的旧盘问法正确。真实模型 API 未重测，现有联调记录属于研发提供的材料。20 条构建追踪提示与 standalone 发布包核验按此前约定归阶段 5；现实占断准确率不在本阶段软件验收范围。

交接文件 `docs/phase4_handoff_acceptance_49c1292_2026-10-07.md` 已进入 Git，但其引用的本轮依据之一 `docs/phase4_reacceptance_49c1292_2026-10-07.md` 及任务书 `docs/phase4_development_spec.md` 仍未跟踪；直接 clone 的验收方无法按这些链接核对。交接摘要的测试数字仍是 `49c1292` 的 83/83、60/60，而当前研发交付说明写的是 92/92、65/65。建议在下次交接时同步基线、数字与可交付的依据文件；此项是文档交接问题，不改变上述功能缺陷判定。
