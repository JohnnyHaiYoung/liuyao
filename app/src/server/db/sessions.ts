import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * 服务端会话（登录态）。
 * Cookie 里只有随机令牌；数据库只保存令牌的 SHA-256，泄库也无法直接复用登录态。
 */

export interface SessionRow {
  id: string;
  owner_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  user_agent: string | null;
}

export interface SessionWithOwner extends SessionRow {
  username: string;
}

export function createSession(
  db: SqliteDatabase,
  params: {
    id: string;
    ownerId: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
    userAgent: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO sessions (id, owner_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    params.id,
    params.ownerId,
    params.tokenHash,
    params.createdAt,
    params.createdAt,
    params.expiresAt,
    params.userAgent,
  );
}

export function findActiveSession(
  db: SqliteDatabase,
  tokenHash: string,
  now: string,
): SessionWithOwner | undefined {
  return db
    .prepare(
      `SELECT s.*, o.username AS username
         FROM sessions s
         JOIN owners o ON o.id = s.owner_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .get(tokenHash, now) as SessionWithOwner | undefined;
}

export function touchSession(db: SqliteDatabase, sessionId: string, lastSeenAt: string): void {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, sessionId);
}

export function extendSession(db: SqliteDatabase, sessionId: string, expiresAt: string): void {
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, sessionId);
}

export function revokeSession(db: SqliteDatabase, sessionId: string, revokedAt: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    revokedAt,
    sessionId,
  );
}

/** 清理过期/已撤销的历史会话记录，避免 sessions 表无限增长。 */
export function purgeStaleSessions(db: SqliteDatabase, now: string, revokedBefore: string): number {
  const result = db
    .prepare('DELETE FROM sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)')
    .run(now, revokedBefore);
  return result.changes;
}
