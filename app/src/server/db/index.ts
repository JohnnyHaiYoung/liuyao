import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { ensureStorageDirs, getConfig } from '../config';
import { hashPassword, hashProblemHint, looksLikePasswordHash, verifyPassword } from '../auth/password';

/**
 * SQLite 连接、版本化迁移与启动恢复。
 *
 * better-sqlite3 是同步 API：单用户短事务可以接受，
 * 但调用模型时必须先释放事务（见 chat/stream-service.ts）。
 */

const MIGRATION_FILE_PATTERN = /^(\d{4})_[A-Za-z0-9_.-]+\.sql$/;

export interface MigrationRecord {
  version: number;
  name: string;
  appliedAt: string;
}

interface GlobalWithDb {
  __liuyaoDatabase?: SqliteDatabase;
  __liuyaoBootstrapped?: boolean;
  __liuyaoStartupLog?: string[];
}

const globalRef = globalThis as unknown as GlobalWithDb;

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function listAppliedMigrations(db: SqliteDatabase): MigrationRecord[] {
  ensureMigrationsTable(db);
  const rows = db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC')
    .all() as Array<{ version: number; name: string; applied_at: string }>;
  return rows.map((row) => ({ version: row.version, name: row.name, appliedAt: row.applied_at }));
}

/** 按文件名顺序应用迁移；每个文件在独立事务中执行，失败即整体回滚。 */
export function applyMigrations(db: SqliteDatabase, migrationsDir: string): MigrationRecord[] {
  ensureMigrationsTable(db);
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`找不到迁移目录：${migrationsDir}`);
  }
  const appliedVersions = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();

  for (const file of files) {
    const version = Number.parseInt(MIGRATION_FILE_PATTERN.exec(file)![1]!, 10);
    if (appliedVersions.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const runMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        version,
        file,
        new Date().toISOString(),
      );
    });
    runMigration();
    appliedVersions.add(version);
  }

  return listAppliedMigrations(db);
}

/**
 * 进程异常重启后，遗留的 streaming 助手消息标为 interrupted，
 * 避免历史里永久显示“正在生成”。
 */
export function recoverInterruptedMessages(db: SqliteDatabase): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE messages
          SET status = 'interrupted',
              error_code = 'server_restart',
              completed_at = ?,
              updated_at = ?
        WHERE status = 'streaming'`,
    )
    .run(now, now);
  return result.changes;
}

export interface OwnerRow {
  id: string;
  username: string;
  password_hash: string;
  password_updated_at: string;
  created_at: string;
  updated_at: string;
}

export function findOwnerByUsername(db: SqliteDatabase, username: string): OwnerRow | undefined {
  return db.prepare('SELECT * FROM owners WHERE username = ?').get(username) as OwnerRow | undefined;
}

export function findOwnerById(db: SqliteDatabase, id: string): OwnerRow | undefined {
  return db.prepare('SELECT * FROM owners WHERE id = ?').get(id) as OwnerRow | undefined;
}

/**
 * 拥有者账户由服务器环境变量引导（密码只存哈希）。
 * 环境变量存在时以它为准，便于轮换口令后重启生效。
 */
function bootstrapOwner(db: SqliteDatabase): void {
  const { owner } = getConfig();
  const now = new Date().toISOString();
  const existing = findOwnerByUsername(db, owner.username);

  const envHash = owner.passwordHash && looksLikePasswordHash(owner.passwordHash) ? owner.passwordHash : null;
  if (owner.passwordHash && !envHash) {
    // 只输出格式层面的提示，不回显用户提供的值。
    console.error(
      `[liuyao] LIUYAO_OWNER_PASSWORD_HASH 格式不可用，已忽略：${hashProblemHint(owner.passwordHash)}`,
    );
  }

  if (envHash) {
    if (!existing) {
      db.prepare(
        `INSERT INTO owners (id, username, password_hash, password_updated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), owner.username, envHash, now, now, now);
      console.info(`[liuyao] 已按环境变量创建拥有者账户：${owner.username}`);
    } else if (existing.password_hash !== envHash) {
      db.prepare(
        'UPDATE owners SET password_hash = ?, password_updated_at = ?, updated_at = ? WHERE id = ?',
      ).run(envHash, now, now, existing.id);
      console.info('[liuyao] 已按环境变量更新拥有者密码哈希。');
    }
    return;
  }

  if (owner.password) {
    if (!existing || !verifyPassword(owner.password, existing.password_hash)) {
      const hash = hashPassword(owner.password);
      if (!existing) {
        db.prepare(
          `INSERT INTO owners (id, username, password_hash, password_updated_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), owner.username, hash, now, now, now);
        console.info(`[liuyao] 已按环境变量创建拥有者账户：${owner.username}`);
      } else {
        db.prepare(
          'UPDATE owners SET password_hash = ?, password_updated_at = ?, updated_at = ? WHERE id = ?',
        ).run(hash, now, now, existing.id);
        console.info('[liuyao] 已按环境变量更新拥有者密码。');
      }
    }
  }

  if (!existing && !envHash && !owner.password) {
    console.warn(
      '[liuyao] 尚未配置拥有者密码：请设置 LIUYAO_OWNER_PASSWORD_HASH（推荐）或 LIUYAO_OWNER_PASSWORD，然后重启服务。',
    );
  }
}

export function startupLog(): string[] {
  return globalRef.__liuyaoStartupLog ?? [];
}

function openDatabase(): SqliteDatabase {
  const config = getConfig();
  ensureStorageDirs();

  const db = new Database(config.databasePath);
  // WAL 适合“频繁写入 + 同时读取”的单机场景；NORMAL 在 WAL 下仍然安全。
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const migrations = applyMigrations(db, config.migrationsDir);
  bootstrapOwner(db);
  const recovered = recoverInterruptedMessages(db);

  const log = [
    `[liuyao] 数据库：${config.databasePath}`,
    `[liuyao] 迁移版本：${migrations.length === 0 ? '（无）' : migrations.map((m) => m.name).join(', ')}`,
  ];
  if (config.llm.fakeMode) {
    log.push(
      '[liuyao] 警告：LIUYAO_FAKE_MODEL=1，聊天由本地验收用假模型生成，未调用 DeepSeek；生产环境不得启用。',
    );
  }
  if (recovered > 0) {
    log.push(`[liuyao] 启动恢复：${recovered} 条 streaming 消息已标记为 interrupted。`);
  }
  globalRef.__liuyaoStartupLog = log;
  for (const line of log) console.info(line);

  return db;
}

/** 进程内单例；开发模式热重载时复用同一连接。 */
export function getDb(): SqliteDatabase {
  if (!globalRef.__liuyaoDatabase || !globalRef.__liuyaoDatabase.open) {
    globalRef.__liuyaoDatabase = openDatabase();
  }
  return globalRef.__liuyaoDatabase;
}

/** 健康检查等只读路径使用：不触发迁移与引导。 */
export function peekDb(): { ok: boolean; migrations: number } {
  try {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
    return { ok: true, migrations: row.count };
  } catch {
    return { ok: false, migrations: 0 };
  }
}

export function closeDb(): void {
  if (globalRef.__liuyaoDatabase?.open) {
    globalRef.__liuyaoDatabase.close();
  }
  globalRef.__liuyaoDatabase = undefined;
}
