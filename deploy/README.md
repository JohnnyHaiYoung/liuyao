# 单目录发布包约定

目标是生成一个可复制到服务器的 `liuyao-agent/` 目录或其压缩包。发布包内至少有 `app/`、`corpus/originals/`、`corpus/extracted/`、`corpus/cleaned/`、`corpus/assets/`、`corpus/reports/`、`corpus/manifest.jsonl`、`wiki/`、`skills/` 以及启动配置模板和依赖说明。所需资料及 Markdown 引用的图片都随包走；任何运行代码和知识页都不得依赖 `F:` 或 `E:` 的绝对路径。

打包程序将在后续阶段实现。它需要逐项核对文件存在、哈希、manifest 相对路径、Markdown 图片链接、Wiki 来源链接和 Skill 依赖，再在独立目录中试运行。当前项目只是目录骨架，不能直接部署。

API Key 不写入发布包；由服务器环境变量或服务器密钥管理提供。运行日志与私人咨询记录留在独立的可写目录，不随下一次发布覆盖。

Git 忽略大体积原件和生成文本只影响版本管理；正式打包必须从项目工作目录显式加入这些文件。不能把 `git clone` 当作完成的发布包。服务器系统及是否使用容器尚待确定；无论选哪种启动方式，以上文件契约保持一致。

## 第一阶段：单实例 Node 服务 + 持久化 storage/

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
export LIUYAO_OWNER_PASSWORD_HASH='scrypt$32768$8$1$...'   # 见 app/README.md 的 hash-password
export DEEPSEEK_API_KEY='...'                              # 只放服务器环境，不入包
npm start                                                  # 默认 127.0.0.1:3000
```

- 反向代理示例见 [nginx.liuyao.conf.example](nginx.liuyao.conf.example)：必须关闭该聊天接口的响应缓冲与压缩，
  并透传 `X-Forwarded-Proto`（应用据此决定登录 Cookie 是否带 `Secure`）。
- `storage/` 保存数据库、备份与日志；`npm run db:backup` 生成一致性备份，恢复步骤见
  [第一阶段交付说明](../docs/phase1_delivery.md)。**发布包不得覆盖 `storage/`**。
- 环境变量模板见项目根 [.env.example](../.env.example)；密钥只通过服务器环境注入，发布包内不得包含真实密钥。
- 进程管理建议用 systemd 单实例（不要多副本：会话、并发登记与限流是进程内状态，SQLite 也是单文件）。

