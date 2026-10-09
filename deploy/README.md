# 单目录发布包约定

当前进入 Linux Docker 发布阶段；最终交付形态和验收门槛以[第五阶段研发任务书](../docs/phase5_development_spec.md)为准。下文记录此前的单目录约定及非容器部署示例，**不是已完成的 Docker 部署说明**。

目标是生成一个可复制到服务器的 `liuyao-agent/` 目录或其压缩包。发布包内至少有 `app/`、`corpus/originals/`、`corpus/extracted/`、`corpus/cleaned/`、`corpus/assets/`、`corpus/reports/`、`corpus/manifest.jsonl`、`wiki/`、`skills/` 以及启动配置模板和依赖说明。所需资料及 Markdown 引用的图片都随包走；任何运行代码和知识页都不得依赖 `F:` 或 `E:` 的绝对路径。

完整应用的 Docker 打包程序将在第五阶段实现。它需要逐项核对文件存在、哈希、manifest 相对路径、Markdown 图片链接、Wiki 来源链接和 Skill 依赖，再从实际交付包在隔离环境中试运行。当前仓库已有可本地运行的应用，但尚无已验收的 Docker 发布包。

API Key 不写入发布包；由服务器环境变量或服务器密钥管理提供。运行日志与私人咨询记录留在独立的可写目录，不随下一次发布覆盖。

Git 忽略大体积原件和生成文本只影响版本管理；正式打包必须从项目工作目录显式加入这些文件。不能把 `git clone` 当作完成的发布包。用户已确定服务器使用 Linux + Docker；以上文件契约仍然适用，容器内外监听地址和数据卷映射须按第五阶段任务书重新核验。

## 既有非容器示例：单实例 Node 服务 + 持久化 storage/

阶段 1 的可运行实现位于 `app/`，按以下方式部署（Linux 服务器，Node 22 LTS）：

```bash
# 1) 只复制需要的部分：app/（含 migrations/ 与 scripts/）、wiki/、corpus/、skills/、deploy/
# 2) 安装依赖与构建（不要从 Windows 复制 node_modules）
cd app
npm ci                 # 严格按 package-lock.json 安装
npm run build
# 3) 把运行时数据放在持久化目录，并在升级应用时保留
export LIUYAO_STORAGE_DIR=/srv/liuyao/storage
export LIUYAO_PROJECT_ROOT=/srv/liuyao
export LIUYAO_OWNER_PASSWORD_HASH='scrypt:32768:8:1:...'       # 见 app/README.md 的 hash-password
export DEEPSEEK_API_KEY='...'                              # 只放服务器环境，不入包
npm start -- -H 127.0.0.1                                  # 关键：显式只监听回环
```

- **监听地址必须显式绑定 `127.0.0.1`**：`next start` 的默认 hostname 是 `0.0.0.0`（可用
  `next start --help` 核对），若服务器放行应用端口，访问者可以绕过 HTTPS 代理直连应用。
  用 systemd 时写 `ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000`。
- **来源 IP 信任链**：应用默认不信任 `X-Forwarded-For`/`X-Real-IP`（可被客户端伪造），
  限流按单一来源计数。只有在应用只监听回环、且代理**覆盖写入** `X-Real-IP` 之后，
  才设置 `LIUYAO_TRUST_PROXY=1` 让限流按真实 IP 分桶；`HEALTHZ` 的 `server.trustProxy`
  与启动日志会显示当前是否启用。
- 反向代理示例见 [nginx.liuyao.conf.example](nginx.liuyao.conf.example)：必须关闭该聊天接口的响应缓冲与压缩，
  并透传 `X-Forwarded-Proto`（应用据此决定登录 Cookie 是否带 `Secure`）。
- `storage/` 保存数据库、备份与日志；`npm run db:backup` 生成一致性备份，恢复步骤见
  [第一阶段交付说明](../docs/phase1_delivery.md)。**发布包不得覆盖 `storage/`**。
- 环境变量模板见项目根 [.env.example](../.env.example)；密钥只通过服务器环境注入，发布包内不得包含真实密钥。
- 进程管理建议用 systemd 单实例（不要多副本：会话、并发登记与限流是进程内状态，SQLite 也是单文件）。
