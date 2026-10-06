/**
 * 盘面与来源快照读写（阶段 4 任务书第 4、6 节）
 *
 * 约定：
 *   - 盘面快照落 `chart_runs`，只存 canonical JSON + 稳定哈希 + 版本号；
 *   - 来源快照落 `message_sources`，保存当时的摘录/定位/质量/页哈希，Wiki 之后变化也不影响历史回看；
 *   - 旧消息（阶段 1 写入）没有这些记录，读出即为"无盘/无来源"，不改动其原文、状态、标题与模型。
 */
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ChartRunSuccess } from './service.ts';

export interface ChartRunRecord {
  id: string;
  conversationId: string;
  createdByMessageId: string | null;
  sourceInput: string | null;
  lineValues: number[];
  mode: string;
  castAt: string | null;
  timezone: string | null;
  dayBoundary: string | null;
  dayGanzhi: string | null;
  monthBranch: string | null;
  calendarSource: string | null;
  ruleProfileVersion: string;
  coreVersion: string;
  canonicalHash: string;
  chartJson: string;
  errorCode: string | null;
  createdAt: string;
}

export interface MessageSourceRecord {
  id: string;
  messageId: string;
  sid: string;
  sourceId: string;
  pagePath: string;
  locatorType: string;
  locatorValue: string | null;
  qualityStatus: string;
  excerpt: string;
  pageSha256: string;
  createdAt: string;
}

/** 保存一次新盘（只接受成功结果；失败不写盘面，避免伪造完整字段）。 */
export function insertChartRun(
  db: SqliteDatabase,
  params: {
    conversationId: string;
    createdByMessageId?: string | null;
    sourceInput?: string | null;
    result: ChartRunSuccess;
  },
): string {
  const id = randomUUID();
  const { result } = params;
  db.prepare(
    `INSERT INTO chart_runs (
       id, conversation_id, created_by_message_id, source_input, line_values, mode, cast_at, timezone,
       day_boundary, day_ganzhi, month_branch, calendar_source, rule_profile_version, core_version,
       canonical_hash, chart_json, error_code, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    params.conversationId,
    params.createdByMessageId ?? null,
    params.sourceInput ?? null,
    JSON.stringify(result.normalized.lineValues),
    result.normalized.mode,
    result.normalized.castAt,
    result.normalized.timezone,
    result.normalized.dayBoundary,
    result.normalized.dayGanzhi,
    result.normalized.monthBranch,
    result.calendar.library,
    result.ruleProfileVersion,
    result.coreVersion,
    result.canonicalHash,
    result.canonicalJson,
    new Date().toISOString(),
  );
  return id;
}

/** 记录一次排盘失败（保留输入与错误码，便于历史如实显示"未生成盘"）。 */
export function insertFailedChartRun(
  db: SqliteDatabase,
  params: { conversationId: string; createdByMessageId?: string | null; sourceInput?: string | null; lineValues: number[]; errorCode: string },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO chart_runs (
       id, conversation_id, created_by_message_id, source_input, line_values, mode, cast_at, timezone,
       day_boundary, day_ganzhi, month_branch, calendar_source, rule_profile_version, core_version,
       canonical_hash, chart_json, error_code, created_at
     ) VALUES (?, ?, ?, ?, ?, 'none', NULL, NULL, NULL, NULL, NULL, NULL, 'liuyao-rule-profile.v1', 'paipan-core/0.1.0', '', '', ?, ?)`,
  ).run(
    id,
    params.conversationId,
    params.createdByMessageId ?? null,
    params.sourceInput ?? null,
    JSON.stringify(params.lineValues ?? []),
    params.errorCode,
    new Date().toISOString(),
  );
  return id;
}

function rowToChartRun(row: Record<string, unknown> | undefined): ChartRunRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    createdByMessageId: row.created_by_message_id === null || row.created_by_message_id === undefined ? null : String(row.created_by_message_id),
    sourceInput: row.source_input === null || row.source_input === undefined ? null : String(row.source_input),
    lineValues: JSON.parse(String(row.line_values ?? '[]')) as number[],
    mode: String(row.mode),
    castAt: row.cast_at == null ? null : String(row.cast_at),
    timezone: row.timezone == null ? null : String(row.timezone),
    dayBoundary: row.day_boundary == null ? null : String(row.day_boundary),
    dayGanzhi: row.day_ganzhi == null ? null : String(row.day_ganzhi),
    monthBranch: row.month_branch == null ? null : String(row.month_branch),
    calendarSource: row.calendar_source == null ? null : String(row.calendar_source),
    ruleProfileVersion: String(row.rule_profile_version),
    coreVersion: String(row.core_version),
    canonicalHash: String(row.canonical_hash),
    chartJson: String(row.chart_json),
    errorCode: row.error_code == null ? null : String(row.error_code),
    createdAt: String(row.created_at),
  };
}

/** 读取盘面快照；旧盘追问只读它，**不重算**。 */
export function getChartRun(db: SqliteDatabase, chartRunId: string): ChartRunRecord | null {
  return rowToChartRun(db.prepare('SELECT * FROM chart_runs WHERE id = ?').get(chartRunId) as Record<string, unknown> | undefined);
}

/** 取某条助手消息当时绑定的盘面快照（历史回看以它为准，不随会话当前盘变化）。 */
export function getChartRunForMessage(db: SqliteDatabase, messageId: string): ChartRunRecord | null {
  const row = db.prepare('SELECT chart_run_id FROM messages WHERE id = ?').get(messageId) as { chart_run_id?: string | null } | undefined;
  if (!row?.chart_run_id) return null;
  return getChartRun(db, row.chart_run_id);
}

/** 会话当前盘引用（可空，仅作提示；不覆盖历史消息的绑定）。 */
export function setCurrentChartRun(db: SqliteDatabase, conversationId: string, chartRunId: string): void {
  db.prepare('UPDATE conversations SET current_chart_run_id = ? WHERE id = ?').run(chartRunId, conversationId);
}

export function getCurrentChartRun(db: SqliteDatabase, conversationId: string): ChartRunRecord | null {
  const row = db
    .prepare('SELECT current_chart_run_id FROM conversations WHERE id = ?')
    .get(conversationId) as { current_chart_run_id?: string | null } | undefined;
  if (!row?.current_chart_run_id) return null;
  return getChartRun(db, row.current_chart_run_id);
}

/** 绑定助手消息与其盘面快照、计划对象与提示版本。 */
export function bindMessageChart(
  db: SqliteDatabase,
  params: { messageId: string; chartRunId: string | null; planJson?: string | null; promptVersion?: string | null },
): void {
  db.prepare('UPDATE messages SET chart_run_id = ?, plan_json = COALESCE(?, plan_json), prompt_version = COALESCE(?, prompt_version) WHERE id = ?').run(
    params.chartRunId,
    params.planJson ?? null,
    params.promptVersion ?? null,
    params.messageId,
  );
}

/** 保存本次回答实际引用的来源快照（只保存服务端验证过的编号）。 */
export function insertMessageSources(
  db: SqliteDatabase,
  messageId: string,
  sources: Array<{ sid: string; sourceId: string; pagePath: string; locatorType: string; locatorValue: string | null; qualityStatus: string; excerpt: string; pageSha256: string }>,
): number {
  const now = new Date().toISOString();
  const statement = db.prepare(
    `INSERT INTO message_sources (id, message_id, sid, source_id, page_path, locator_type, locator_value, quality_status, excerpt, page_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const run = db.transaction((items: typeof sources) => {
    for (const item of items) {
      statement.run(randomUUID(), messageId, item.sid, item.sourceId, item.pagePath, item.locatorType, item.locatorValue, item.qualityStatus, item.excerpt, item.pageSha256, now);
    }
    return items.length;
  });
  return run(sources);
}

export function listMessageSources(db: SqliteDatabase, messageId: string): MessageSourceRecord[] {
  return (db.prepare('SELECT * FROM message_sources WHERE message_id = ? ORDER BY sid ASC').all(messageId) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    messageId: String(row.message_id),
    sid: String(row.sid),
    sourceId: String(row.source_id),
    pagePath: String(row.page_path),
    locatorType: String(row.locator_type),
    locatorValue: row.locator_value == null ? null : String(row.locator_value),
    qualityStatus: String(row.quality_status),
    excerpt: String(row.excerpt),
    pageSha256: String(row.page_sha256),
    createdAt: String(row.created_at),
  }));
}
