-- 0001_init.sql
-- 第一阶段：可持久保存的自由聊天网站
--
-- 约定：
--   * 所有时间戳以 ISO-8601 UTC 字符串保存（例如 2026-10-01T08:00:00.000Z），
--     页面按用户所在时区渲染；排序与分页不依赖客户端时钟。
--   * 主键为不可预测的随机 ID（UUID v4），会话 ID 会出现在 URL 中。
--   * 本文件只创建表与索引，不插入业务数据；拥有者账户在启动引导时写入。

-- 拥有者账户（首版仅一个）。密码只保存强哈希，绝不保存明文。
CREATE TABLE IF NOT EXISTS owners (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  password_updated_at TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 服务端会话：Cookie 中只放随机令牌，库中只放其 SHA-256。
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions (owner_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- 会话（会话列表项）。client_conversation_id 用于“首条发送时才创建”的重试去重。
CREATE TABLE IF NOT EXISTS conversations (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  client_conversation_id TEXT NOT NULL,
  title                  TEXT NOT NULL DEFAULT '',
  title_source           TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'manual')),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  last_message_at        TEXT,
  UNIQUE (owner_id, client_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_owner_updated
  ON conversations (owner_id, updated_at DESC);

-- 消息：用户消息与助手消息同一张表。
--   status 语义
--     user      -> completed（已保存）
--     assistant -> streaming / completed / interrupted / failed
CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  owner_id          TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  client_message_id TEXT,
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content           TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL CHECK (status IN ('streaming', 'completed', 'interrupted', 'failed')),
  provider          TEXT,
  model             TEXT,
  prompt_version    TEXT,
  error_code        TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  total_tokens      INTEGER,
  latency_ms        INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  -- 同一会话内，客户端消息 ID 唯一（SQLite 允许多行 NULL，助手消息不受影响）。
  UNIQUE (conversation_id, client_message_id)
);

-- 历史分页按 rowid（插入顺序）稳定排序，避免同一毫秒时间戳导致顺序抖动。
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages (conversation_id, created_at);
