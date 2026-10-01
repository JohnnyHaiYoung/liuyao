# Agent 程序（第一阶段已实现）

本目录是第一阶段的可运行实现：Next.js App Router + TypeScript + SQLite，提供单用户登录、自由聊天、
DeepSeek Flash 流式回复、停止生成、历史会话、标题重命名与持久化。

```
app/
├─ src/app/            页面与 Route Handler（/api/**）
├─ src/components/     登录表单、聊天界面、Markdown 安全渲染
├─ src/lib/            浏览器侧接口封装与 SSE 解析
├─ src/server/         服务端模块：配置、数据库、鉴权、模型适配、聊天编排
│  ├─ db/              SQLite 连接、版本化迁移、启动恢复、数据访问
│  ├─ auth/            scrypt 口令哈希、服务端会话 Cookie
│  ├─ llm/             模型适配层边界（deepseek.ts / fake.ts / types.ts）
│  ├─ chat/            流式编排、并发登记、标题规则
│  └─ http/            JSON 响应、SSE 编码、限流、输入校验
├─ migrations/         版本化 SQL 迁移（0001_init.sql）
└─ scripts/            运维与验收脚本（哈希口令、备份、巡检、验收自检）
```

## 启动

```bash
# 在 app/ 目录
npm ci                       # 按 package-lock.json 安装；app/.npmrc 设了 ignore-scripts（见下方说明）
npm run build
npm start -- -H 127.0.0.1    # 建议显式只监听回环：next start 默认是 0.0.0.0
```

> **监听地址**：`next start` 的默认 hostname 是 `0.0.0.0`（`next start --help` 可核对）。
> 本机自用建议加 `-H 127.0.0.1`；若放在反向代理后，也必须只监听回环，否则可以绕过代理直连应用。
> 需要局域网直接访问时才显式 `-H 0.0.0.0`，并自行评估暴露面。

> `app/.npmrc` 里设置 `ignore-scripts=true`：本项目依赖无需安装期编译。
> better-sqlite3 包内有 `binding.gyp` 却没有自定义 install 脚本，npm 默认会调用 node-gyp 编译并在
> 无 Visual Studio 的机器上失败；该包实际自带各平台预编译二进制，跳过脚本即可直接用。
> 新增依赖时请复核它是否需要安装脚本。

环境变量见项目根目录 [.env.example](../.env.example)：
`DEEPSEEK_API_KEY`（必需，缺省时页面显示明确的配置错误）、`LIUYAO_OWNER_PASSWORD_HASH`
（用 `npm run hash-password` 生成）、`LIUYAO_STORAGE_DIR`（默认 `<项目根>/storage`）。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 开发模式 |
| `npm run build` / `npm start` | 生产构建 / 单实例启动 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run hash-password` | 生成拥有者口令哈希（冒号格式，可直接写入 `.env.local`） |
| `npm run db:backup` | 一致性备份到 `storage/backups/`，并做完整性检查 |
| `npm run db:info` | 只读巡检：迁移版本、WAL、计数、状态分布 |
| `npm run verify:phase1` | 黑盒验收自检（需服务已启动，密码放 `LIUYAO_VERIFY_PASSWORD`） |

回归与验收辅助脚本（详见 [交付说明](../docs/phase1_delivery.md) 第 13 节）：

| 脚本 | 用途 |
| --- | --- |
| `scripts/mock-deepseek-upstream.mjs` | 可控模拟上游（正常/长度上限/提前 EOF/连接重置/5xx/401/慢速/空正文），仅测试用 |
| `scripts/check-adapter-states.mjs` | 适配层终止语义回归：逐态断言事件序列与落库状态 |
| `scripts/seed-conversations.mjs` | 播种 N 条会话，用于历史列表分页验收 |
| `scripts/check-conversations-paging.mjs` | 分页验收：最早一条会话可列出/打开/重命名/继续 |
| `scripts/acceptance-run.ps1` | 一键编排：默认验收 / `-AdapterCheck` / `-PagingCheck` / `-ApiKeyFromFile`（真实密钥联调） |

## 边界

- `corpus/`、`wiki/`、`skills/` 在本阶段**不被读取**：没有 Wiki 阅读器，也没有排盘程序。
  页面与系统提示词都明确要求不得声称读过资料或算出卦盘。
- 模型适配层（`src/server/llm/`）是后续接入千问、Wiki 片段与排盘工具的唯一入口；
  浏览器协议（SSE `start/delta/done/error`）保持不变。
- 数据库位于项目根的 `storage/`（持久化目录），不与只读知识资料混放。

详细交付说明、接口/SSE 示例、备份恢复步骤与验收实测记录见
[第一阶段交付说明](../docs/phase1_delivery.md)。
