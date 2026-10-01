#!/usr/bin/env node
/**
 * 造会话种子数据：为「历史列表分页」验收准备 N 条带消息的会话（默认 55 条）。
 *
 * 直接写 SQLite（不走 API、不调用模型），因此可以快速造出第 51 条及更早的会话。
 * 标题按 `种子会话 NN` 递增编号，编号越小更新时间越新，便于断言顺序与“最早一条”。
 *
 * 用法：
 *   node scripts/seed-conversations.mjs --count 55 [--storage <dir>] [--prefix 种子会话]
 * 输出：写入条数、最早一条的 id 与标题（供后续断言使用）。
 */

import Database from 'better-sqlite3';
import { databasePath, storageDir as defaultStorageDir } from './lib/paths.mjs';
import { randomUUID } from 'node:crypto';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const count = Number.parseInt(argValue('--count', '55'), 10);
const storage = argValue('--storage', defaultStorageDir());
const prefix = argValue('--prefix', '种子会话');
const dbFile = argValue('--db', databasePath());

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');

const owner = db.prepare('SELECT id FROM owners ORDER BY created_at LIMIT 1').get();
if (!owner) {
  console.error('数据库里还没有拥有者账户，请先启动一次服务（会按环境变量创建）。');
  process.exit(2);
}

const insertConversation = db.prepare(
  `INSERT INTO conversations (id, owner_id, client_conversation_id, title, title_source, created_at, updated_at, last_message_at)
   VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)`,
);
const insertMessage = db.prepare(
  `INSERT INTO messages (id, conversation_id, owner_id, client_message_id, role, content, status, provider, model, prompt_version, created_at, updated_at, completed_at, output_tokens, total_tokens)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const base = Date.now();
let oldest = null;

const seed = db.transaction(() => {
  for (let index = 1; index <= count; index += 1) {
    const id = randomUUID();
    const title = `${prefix} ${String(index).padStart(2, '0')}`;
    // 编号越小越新：index=1 是最新，index=count 是最早。
    const stamp = new Date(base - index * 60_000).toISOString();
    insertConversation.run(id, owner.id, `seed-${index}-${randomUUID()}`, title, stamp, stamp, stamp);
    insertMessage.run(
      randomUUID(),
      id,
      owner.id,
      randomUUID(),
      'user',
      `${title}：这是用于分页验收的问题。`,
      'completed',
      null,
      null,
      null,
      stamp,
      stamp,
      stamp,
      null,
      null,
    );
    insertMessage.run(
      randomUUID(),
      id,
      owner.id,
      null,
      'assistant',
      `${title}：这是对应的回答。`,
      'completed',
      'fake',
      'seed-fixture',
      'seed',
      stamp,
      stamp,
      stamp,
      12,
      12,
    );
    if (index === count) oldest = { id, title };
  }
});
seed();
db.close();

console.log(`已写入 ${count} 条会话（存储：${storage}，数据库：${dbFile}）`);
console.log(`最早一条：${oldest?.title} id=${oldest?.id}`);
