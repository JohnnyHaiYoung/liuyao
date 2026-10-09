# 第四阶段独立验收报告（2026-10-06）

基线：`HEAD 7467a4b` 加当前工作区未提交改动；对照 `docs/phase4_development_spec.md`。本次只检查与记录，没有修改产品代码。当前工作区的 `app/src/server/chat/stream-service.ts`、`app/src/shared/types.ts` 尚未提交，因此以下结果还不是可重建的交付版本。

## 结论

**未通过第四阶段验收。** Wiki 目录、来源阅读器、排盘服务和编排对象已有局部实现，离线模块检查通过；但生产构建失败，网页到历史的四条主流程尚未闭环。应在修复后以明确提交号重新验收。

## 已核实的通过项

| 检查 | 实际结果 |
| --- | --- |
| `cd app; npm run typecheck` | 退出码 0 |
| `cd app; npm run check:wiki` | 目录一致；选页 17/17、来源阅读器 28/28，退出码 0 |
| `cd app; npm run check:chart` | 排盘服务 32/32，退出码 0 |
| `cd app; npm run check:orchestration` | 编排层 35/35，退出码 0 |
| Node 直接导入 `liuyao-paipan` | 成功；本机 `app/node_modules/liuyao-paipan` 为指向仓库 `paipan` 的 junction |

这些检查验证了局部函数，不能替代 Next 生产构建与网页端到端验收。

## 阻断问题

### P0-1 生产构建失败

`cd app; npm run build` 退出码 1。Next 16.3.8 的 Turbopack 在 `app/src/server/chart/service.ts:13` 报 `Module not found: Can't resolve 'liuyao-paipan'`。Node 直接导入该包成功，因此不能简单归因为本机没有安装依赖。需修复 Next 的包解析/打包方式，并从锁文件安装后的交付目录复现成功构建。构建还报告多处动态文件访问导致追踪整个项目的警告；在阶段 5 打包时应确认实际产物范围。

### P1-1 排盘请求没有进入聊天接口

`app/src/shared/types.ts:135` 的 `ChatRequest` 仍只有 `clientMessageId/content/model`；`app/src/app/api/conversations/[id]/messages/route.ts:85` 调用 `startChatStream` 时没有传 `chartInput/chartAction`。虽然后者在未提交的 `stream-service.ts:44` 定义了这两个参数，网页请求不能走结构化排盘入口；当前也没有请求字段的服务端校验或浏览器输入区。

### P1-2 缺项场景错误分流

用真实目录直接调用 `planTurn('帮我起卦')`，得到 `intent='source_comparison'`、`missingInputs=[]`、`buildMissingInputReply=null`。因此最基本的起卦请求会进入模型通道，不能按任务书先询问六爻、起卦时刻和时区。原因可定位到 `app/src/server/chat/planner.ts:73-128`：只在提取到某些输入时尝试排盘，单纯起卦意图会被 Wiki 选页分类覆盖。应补独立的起卦意图与缺项检查，并加入该原话的回归样例。

### P1-3 历史快照和页面呈现未接通

`app/src/server/db/messages.ts:29` 的 DTO 转换及 `:228` 的历史分页仍只返回阶段 1 字段；`app/src/shared/types.ts:62` 的 `MessageDto` 无 `sources/chart`；`app/src/lib/api-client.ts:230` 只处理 `delta/done`，没有处理 `sources/chart`；`app/src/components/ChatApp.tsx` 没有盘面/出处展示。数据库快照写入函数存在，但用户无法在网页或历史回看它们，更无法展开依据与原页图。旧卦追问的 `chart` 事件也不会发出：`stream-service.ts:244` 要求 `planned.chart && planned.chart.ok`，而追问时 `planner.ts` 返回的 `chart` 为 `null`。

### P1-4 千问适配器未交付

`app/src/server/llm/index.ts:22` 仅注册 DeepSeek，另有验收假模型；未找到 Qwen 适配器、密钥条件下的模型列表与相应配置。`app/src/shared/types.ts` 的可选模型也仍只有 `deepseek-flash`。任务书要求的千问切换与无密钥降级尚未实现。

### P1-5 来源事件把候选片段提前当作可点击出处

未提交的 `app/src/server/chat/stream-service.ts:199-211` 从全部 `citable` 候选构建 `evidenceRefs`，`:349` 在模型回答前发出 `sources`；实际引用校验直到 `:433` 才发生。按任务书，最终可点击引用只能是模型实际提及且通过本次映射的编号。现有顺序会让前端一旦接入该事件就可能展示未被回答引用的出处。`done.sourceIds` 也在来源快照写入失败时仍使用计算出的编号，无法保证与历史一致。

## 交付与复验要求

1. 修复默认生产构建；用清洁安装和交付目录验证 Wiki、排盘的运行时路径。
2. 将 `chartInput/chartAction` 接入请求校验、聊天编排与页面；补 `帮我起卦` 等无输入场景。
3. 历史 GET 返回当时的盘面与已验证出处快照；页面处理 `sources/chart`，新盘和旧盘追问均正确显示；只展示实际引用。保证 SSE `done` 与数据库历史一致。
4. 实现并验证千问适配器、模型列表与配置；无千问密钥时保留 DeepSeek 默认。
5. 增加假上游端到端复验，覆盖概念、来源比较、具体卦例、旧卦追问、S99、缺项、停止/失败、重启历史，以及阶段 1 登录/历史/重命名回归；补 `docs/phase4_delivery.md`，注明真实 API 未联调的条件。
6. 将阶段 4 代码提交，提供提交号和可复跑命令；届时按任务书做最终复验。`docs/phase4_integration_design.md` 已列出待接入的路由、客户端与 UI 步骤，当前实现还未完成这些步骤。

未执行真实 DeepSeek/千问调用、完整网页端到端与旧数据库迁移复验：前两者缺少已构建的阶段 4 服务和千问适配器；本次构建已失败，故不把局部自检结果外推为整体通过。
