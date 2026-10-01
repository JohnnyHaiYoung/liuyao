# 运行时数据目录（storage/）

本目录存放**运行时状态**，与只读知识资料（`corpus/`、`wiki/`、`skills/`）严格分开。

| 路径 | 内容 |
| --- | --- |
| `liuyao.db` | SQLite 主库：拥有者账户、登录会话、会话标题、消息与生成状态、用量 |
| `liuyao.db-wal` / `liuyao.db-shm` | WAL 模式产生的预写日志（属主库的一部分，不能单独删除） |
| `backups/liuyao-YYYYMMDD-HHMMSS.db` | `npm run db:backup` 生成的一致性备份 |
| `verify-*/` | 本地验收自检使用的独立存储目录与日志（可安全删除） |

## 约定

1. **不要提交进 Git**：这里是私人聊天记录。`.gitignore` 已忽略本目录内容，只保留本说明文件。
2. **升级应用时保留**：替换发布包不得覆盖或删除 `storage/`。部署时把它放到持久化卷或独立目录，并用
   `LIUYAO_STORAGE_DIR` 指过去。
3. **备份**：`npm run db:backup` 使用 SQLite 在线备份 API，服务运行中也能得到一致快照，备份后自动做
   `PRAGMA integrity_check`。
4. **恢复**：停止服务 → 将备份文件复制为 `liuyao.db` → 删除旧的 `liuyao.db-wal`、`liuyao.db-shm` →
   启动服务（会自动应用新迁移）。完整步骤见 [第一阶段交付说明](../docs/phase1_delivery.md)。
5. **权限**：目录只需服务进程可读写；不要通过 Web 暴露该目录（应用没有提供任何文件下载端点）。
