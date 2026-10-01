import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { ConversationSummary, TitleSource } from '@/shared/types';

/** 会话（会话列表项）数据访问。 */

export interface ConversationRow {
  id: string;
  owner_id: string;
  client_conversation_id: string;
  title: string;
  title_source: TitleSource;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

interface ConversationSummaryRow extends ConversationRow {
  message_count: number;
  last_message_status: string | null;
  last_model: string | null;
}

const SUMMARY_COLUMNS = `
  c.id, c.owner_id, c.client_conversation_id, c.title, c.title_source,
  c.created_at, c.updated_at, c.last_message_at,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
  (SELECT m.status FROM messages m WHERE m.conversation_id = c.id ORDER BY m.rowid DESC LIMIT 1) AS last_message_status,
  (SELECT m.model FROM messages m WHERE m.conversation_id = c.id AND m.role = 'assistant' ORDER BY m.rowid DESC LIMIT 1) AS last_model
`;

function toSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    titleSource: row.title_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    lastMessageStatus: (row.last_message_status as ConversationSummary['lastMessageStatus']) ?? null,
    lastModel: row.last_model,
  };
}

export function findConversationById(
  db: SqliteDatabase,
  id: string,
  ownerId: string,
): ConversationRow | undefined {
  return db
    .prepare('SELECT * FROM conversations WHERE id = ? AND owner_id = ?')
    .get(id, ownerId) as ConversationRow | undefined;
}

export function findConversationByClientId(
  db: SqliteDatabase,
  ownerId: string,
  clientConversationId: string,
): ConversationRow | undefined {
  return db
    .prepare('SELECT * FROM conversations WHERE owner_id = ? AND client_conversation_id = ?')
    .get(ownerId, clientConversationId) as ConversationRow | undefined;
}

export function createConversation(
  db: SqliteDatabase,
  params: { id: string; ownerId: string; clientConversationId: string; title?: string; now: string },
): ConversationRow {
  db.prepare(
    `INSERT INTO conversations
       (id, owner_id, client_conversation_id, title, title_source, created_at, updated_at, last_message_at)
     VALUES (?, ?, ?, ?, 'auto', ?, ?, NULL)`,
  ).run(
    params.id,
    params.ownerId,
    params.clientConversationId,
    params.title ?? '',
    params.now,
    params.now,
  );
  const row = findConversationById(db, params.id, params.ownerId);
  if (!row) throw new Error('创建会话后无法读取记录');
  return row;
}

export function getConversationSummary(
  db: SqliteDatabase,
  id: string,
  ownerId: string,
): ConversationSummary | undefined {
  const row = db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM conversations c WHERE c.id = ? AND c.owner_id = ?`)
    .get(id, ownerId) as ConversationSummaryRow | undefined;
  return row ? toSummary(row) : undefined;
}

export interface ConversationCursor {
  updatedAt: string;
  id: string;
}

export function encodeCursor(cursor: ConversationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): ConversationCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<ConversationCursor>;
    if (typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') return null;
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * 历史列表：按 updated_at 倒序，不返回没有消息的空草稿。
 */
export function listConversations(
  db: SqliteDatabase,
  ownerId: string,
  options: { limit: number; cursor?: ConversationCursor | null },
): { items: ConversationSummary[]; nextCursor: string | null } {
  const limit = options.limit;
  const params: unknown[] = [ownerId];
  let where = 'c.owner_id = ? AND c.last_message_at IS NOT NULL';
  if (options.cursor) {
    where += ' AND (c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))';
    params.push(options.cursor.updatedAt, options.cursor.updatedAt, options.cursor.id);
  }
  params.push(limit + 1);

  const rows = db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}
         FROM conversations c
        WHERE ${where}
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ?`,
    )
    .all(...params) as ConversationSummaryRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toSummary),
    nextCursor: hasMore && last ? encodeCursor({ updatedAt: last.updated_at, id: last.id }) : null,
  };
}

/** 消息写入后更新会话活动时间（排序键）。 */
export function touchConversation(db: SqliteDatabase, conversationId: string, now: string): void {
  db.prepare('UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?').run(
    now,
    now,
    conversationId,
  );
}

/**
 * 首条用户消息保存后生成默认标题；仅当标题仍为空且来源为 auto 时写入，
 * 手动重命名过的会话不会被覆盖。
 */
export function setAutoTitleIfEmpty(
  db: SqliteDatabase,
  conversationId: string,
  title: string,
): string | null {
  const result = db
    .prepare(
      `UPDATE conversations
          SET title = ?, title_source = 'auto'
        WHERE id = ? AND title_source = 'auto' AND (title IS NULL OR title = '')`,
    )
    .run(title, conversationId);
  if (result.changes === 0) return null;
  return title;
}

/**
 * 手动重命名：去首尾空白由调用方完成。
 * 刻意不修改 updated_at —— 列表排序代表“对话活动时间”，重命名不算一次对话。
 */
export function renameConversation(
  db: SqliteDatabase,
  conversationId: string,
  ownerId: string,
  title: string,
): ConversationSummary | undefined {
  db.prepare("UPDATE conversations SET title = ?, title_source = 'manual' WHERE id = ? AND owner_id = ?").run(
    title,
    conversationId,
    ownerId,
  );
  return getConversationSummary(db, conversationId, ownerId);
}

export interface DeleteConversationResult {
  deleted: boolean;
  deletedMessages: number;
}

/**
 * 删除会话（硬删除）。messages 通过外键 ON DELETE CASCADE 一并清除；
 * 先统计消息条数用于日志与响应，整个过程在单个事务内完成。
 */
export function deleteConversation(
  db: SqliteDatabase,
  conversationId: string,
  ownerId: string,
): DeleteConversationResult {
  const run = db.transaction((): DeleteConversationResult => {
    const counted = db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { count: number };
    const result = db
      .prepare('DELETE FROM conversations WHERE id = ? AND owner_id = ?')
      .run(conversationId, ownerId);
    return {
      deleted: result.changes > 0,
      deletedMessages: result.changes > 0 ? counted.count : 0,
    };
  });
  return run();
}
