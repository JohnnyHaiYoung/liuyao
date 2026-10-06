-- 第四阶段迁移 0002：盘面快照与来源快照
--
-- 约定（阶段 4 任务书第 6 节）：
--   * 不改动 0001_init.sql 的既有含义，不清空既有库；
--   * 由 app/src/server/db 的迁移器按版本号顺序应用，并记入 schema_migrations（因此每个文件只执行一次）；
--   * 旧阶段 1 消息读出来源/盘面为空（NULL），原文、状态、标题、模型字段不变；
--   * 模型调用期间不持有写事务；本文件只建表/建索引/加可空列。

CREATE TABLE IF NOT EXISTS chart_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by_message_id TEXT,
  source_input TEXT,
  line_values TEXT NOT NULL,
  mode TEXT NOT NULL,
  cast_at TEXT,
  timezone TEXT,
  day_boundary TEXT,
  day_ganzhi TEXT,
  month_branch TEXT,
  calendar_source TEXT,
  rule_profile_version TEXT NOT NULL,
  core_version TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  chart_json TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chart_runs_conversation ON chart_runs (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chart_runs_hash ON chart_runs (canonical_hash);

CREATE TABLE IF NOT EXISTS message_sources (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sid TEXT NOT NULL,
  source_id TEXT NOT NULL,
  page_path TEXT NOT NULL,
  locator_type TEXT NOT NULL,
  locator_value TEXT,
  quality_status TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  page_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_sources_message ON message_sources (message_id);
CREATE INDEX IF NOT EXISTS idx_message_sources_source ON message_sources (source_id);

-- 会话当前盘引用（可空）：只作提示，历史消息各自绑定当时的 chart_run_id
ALTER TABLE conversations ADD COLUMN current_chart_run_id TEXT;

-- 每条助手消息绑定当时的盘面快照；旧消息保持 NULL（表示"无盘"）
ALTER TABLE messages ADD COLUMN chart_run_id TEXT;

-- 编排层的计划对象（意图、选页、排盘决策、缺项与理由）；失败/中断时也能看清当时的决策。
-- 注意：提示版本字段 `prompt_version` **在 0001_init.sql 中已存在**（阶段 1 就记录模型提示版本），
-- 本迁移不重复添加；错误码亦沿用既有的 `error_code`，避免与阶段 1 字段重名冲突。
ALTER TABLE messages ADD COLUMN plan_json TEXT;
