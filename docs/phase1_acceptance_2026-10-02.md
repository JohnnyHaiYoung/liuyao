# 第一阶段验收记录（2026-10-02）

验收人：产品与架构方。范围：[第一阶段研发任务书](phase1_development_spec.md)中的私人聊天网站。此次结论仅适用于阶段 1；Wiki 阅读、资料比较、排盘、Skill 集成、千问切换及完整发布包属于后续阶段。

## 结论

**暂不通过第一阶段最终验收；功能主链路可用，但须修复以下问题后复验。** 不把开发方的“29 项通过”直接当作真实 DeepSeek 和服务器部署已通过。其 29 项以及本次独立复跑均使用本地假模型。

## 独立核查结果

| 项目 | 结果 | 证据与限制 |
| --- | --- | --- |
| TypeScript 类型检查、生产构建 | 通过 | 在 `app/` 执行 `npm run typecheck`、`npm run build`，均退出码 0 |
| 登录、流式事件、中断、去重、历史读取、退出 | 模拟环境通过 | 独立存储 `storage/acceptance-20261002/` 下执行 `verify-phase1.mjs`：29 通过、0 未通过；模型为 `fake-stream-v1` |
| 当前会话与历史列表双向改名 | 通过 | 浏览器分别从主区与历史列表改名，另一处即时同步；刷新后标题仍为“历史标题验收” |
| 数据备份与可读性 | 通过 | 在线备份 `integrity_check=ok`；把备份复制到独立恢复目录后，读到 1 条会话、6 条消息、1 个迁移，状态为 completed 5 条、interrupted 1 条 |
| DeepSeek 官方 API 端到端 | 未验 | 没有使用真实 API Key；本地模拟上游仅验证适配器行为，不能证明真实模型调用、费用和响应时延 |
| Linux 服务器及 HTTPS 反向代理 | 未验 | 本次在 Windows 本地运行，无法确认 Linux 原生依赖安装与代理下的首字延迟 |

本次测试使用独立测试密码和目录，未读取或更改用户已有的聊天数据库；正式 API Key 未用于测试。

## 待修复项

### 1. [阻断] 上游流提前结束会被当作完成

位置：[DeepSeek 适配器](../app/src/server/llm/deepseek.ts)。实现读取到流 EOF 后，即使没有 `data: [DONE]` 且 `finish_reason` 仍为空，也返回 `completed`。本次以本地模拟上游返回“未完的回答”后直接关闭流，实际观察到浏览器事件为 `start → delta → done`，数据库助手状态为 `completed`，正文只有“未完的回答”。这会把网络或上游异常误标为可信的完整答复。

修复标准：仅在收到合法的终止事件与可接受的结束原因后写入 `completed`；缺少终止标记、流被截断或上游报错时写入 `failed` 或 `interrupted`，保留部分正文并给页面明确状态。新增“正文后提前 EOF”的回归验收。DeepSeek [Chat Completions 文档](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)说明流以 `data: [DONE]` 结束。

### 2. [上线阻断] 监听地址与来源 IP 信任链不正确

位置：[部署说明](../deploy/README.md)、[Nginx 示例](../deploy/nginx.liuyao.conf.example)和[来源 IP 解析](../app/src/server/http/api.ts)。部署说明称 `npm start` 默认监听 `127.0.0.1`，但 [Next.js CLI 文档](https://nextjs.org/docs/app/api-reference/cli/next)写明 `next start` 的默认 hostname 是 `0.0.0.0`。本地启动输出也显示除 localhost 外的 Network 地址。若服务器开放应用端口，访问者可绕过 HTTPS 代理。与此同时，Nginx 示例用 `$proxy_add_x_forwarded_for` 保留请求自带的 `X-Forwarded-For`，应用却直接选第一段作为登录限流键；攻击者可改写这一段绕过按 IP 的尝试次数限制。

修复标准：正式启动命令显式绑定 `127.0.0.1`（或用网络规则确保应用端口不对外），并写入实际部署说明；由可信代理覆盖而非透传用户可控的来源 IP，应用只信任已确认的代理头。复验须证明直连应用端口不可达，且改变客户端提供的 `X-Forwarded-For` 不能规避登录限流。

### 3. [功能缺口] 超过 50 条的旧会话在网页上不可见

位置：[聊天页面](../app/src/components/ChatApp.tsx)的 `refreshConversations`。页面固定调用 `listConversations(50)`，丢弃返回的 `nextCursor`；界面仅有“加载更早消息”，没有“加载更早会话”。数据库与 API 可保存及分页，用户却无法在网页中打开第 51 条及更早的会话。

修复标准：历史会话列表消费 `nextCursor`，提供“加载更多”或滚动续载；准备至少 51 条有消息的会话，确认最早一条可见、可打开、可继续、可重命名。

### 4. [文档] 用户已确认的标题需求仍被写成“暂定解释”

[交付说明](phase1_delivery.md)第 386 行称“聊天输入框可以重命名”仅为暂定解释。用户已明确要改的是当前聊天和历史会话的**标题**；实际页面实现符合用户要求。修正文档表述，避免后续开发 AI 误改输入框提示语。

## 复验与总体边界

开发方完成上述修复后，先复跑构建与本地假模型链路，再用可控模拟上游验证正常结束、提前 EOF、上游错误与中断四种状态；随后在实际部署路径核对监听、登录限流和流式首段到达。真实 DeepSeek 联调须在服务器环境提供 API Key 后进行，密钥不得写入聊天、代码库或报告。

当前项目**不是完整六爻 Agent**：`corpus/` 仍是目录骨架，Wiki 只有试点页，`skills/` 尚未纳入算法，排盘与资料阅读也未接入聊天。完整产品须继续按[研发计划](development_plan.md)的后续阶段交付和验收；不能用第一阶段网站的可用性替代六爻分析能力验收。
