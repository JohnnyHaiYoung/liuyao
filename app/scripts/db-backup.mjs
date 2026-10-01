#!/usr/bin/env node
/**
 * 数据库安全备份。
 *
 * 使用 SQLite 官方在线备份 API（better-sqlite3 的 db.backup），
 * 在服务运行中也能得到一致快照，不会复制到写入一半的 WAL 文件。
 *
 * 用法：npm run db:backup
 * 输出：<storage>/backups/liuyao-YYYYMMDD-HHMMSS.db（并做 integrity_check 校验）
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupsDir, databasePath, storageDir } from './lib/paths.mjs';

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

async function main() {
  const source = databasePath();
  if (!fs.existsSync(source)) {
    console.error(`找不到数据库：${source}`);
    console.error('服务至少启动过一次（完成迁移）后才有可备份的数据库。');
    process.exitCode = 2;
    return;
  }

  fs.mkdirSync(backupsDir(), { recursive: true });
  const destination = path.join(backupsDir(), `liuyao-${timestamp()}.db`);

  const db = new Database(source, { readonly: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }

  // 校验备份可用：只读打开并跑 integrity_check，顺带统计行数。
  const verify = new Database(destination, { readonly: true });
  let summary;
  try {
    const integrity = verify.pragma('integrity_check', { simple: true });
    const conversations = verify.prepare('SELECT COUNT(*) AS count FROM conversations').get().count;
    const messages = verify.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
    const migrations = verify.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count;
    summary = { integrity, conversations, messages, migrations };
  } finally {
    verify.close();
  }

  const size = fs.statSync(destination).size;
  console.log(`备份完成：${destination}`);
  console.log(`大小：${size} 字节`);
  console.log(`完整性检查：${summary.integrity}`);
  console.log(`会话 ${summary.conversations} 条 / 消息 ${summary.messages} 条 / 迁移 ${summary.migrations} 个`);
  console.log(`存储目录：${storageDir()}`);
  if (summary.integrity !== 'ok') {
    console.error('完整性检查未通过，请不要用这个备份覆盖生产库。');
    process.exitCode = 1;
  }
}

await main();
