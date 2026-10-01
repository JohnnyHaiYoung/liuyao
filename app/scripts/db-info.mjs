#!/usr/bin/env node
/**
 * 数据库只读巡检：迁移版本、WAL 状态、会话与消息计数、生成状态分布。
 * 只输出统计信息，不打印聊天正文。
 *
 * 用法：npm run db:info
 */

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { databasePath } from './lib/paths.mjs';

function main() {
  const file = databasePath();
  if (!fs.existsSync(file)) {
    console.error(`找不到数据库：${file}`);
    process.exitCode = 2;
    return;
  }

  const db = new Database(file, { readonly: true });
  try {
    const journalMode = db.pragma('journal_mode', { simple: true });
    const migrations = db
      .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
      .all();
    const conversations = db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count;
    const messages = db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
    const byStatus = db
      .prepare('SELECT status, COUNT(*) AS count FROM messages GROUP BY status ORDER BY status')
      .all();
    const byRole = db
      .prepare('SELECT role, COUNT(*) AS count FROM messages GROUP BY role ORDER BY role')
      .all();
    const owners = db.prepare('SELECT username, created_at, password_updated_at FROM owners').all();
    const activeSessions = db
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL AND expires_at > ?")
      .get(new Date().toISOString()).count;

    console.log(`数据库文件：${file}`);
    console.log(`文件大小：${fs.statSync(file).size} 字节；journal_mode=${journalMode}`);
    console.log('');
    console.log('迁移：');
    for (const row of migrations) {
      console.log(`  ${String(row.version).padStart(4, '0')} ${row.name}  (applied ${row.applied_at})`);
    }
    console.log('');
    console.log(`拥有者账户：${owners.length === 0 ? '（未配置）' : owners.map((o) => o.username).join(', ')}`);
    console.log(`有效登录会话：${activeSessions}`);
    console.log(`会话 ${conversations} 条 / 消息 ${messages} 条`);
    console.log(`按角色：${byRole.map((row) => `${row.role}=${row.count}`).join(' ') || '（空）'}`);
    console.log(`按状态：${byStatus.map((row) => `${row.status}=${row.count}`).join(' ') || '（空）'}`);
  } finally {
    db.close();
  }
}

main();
