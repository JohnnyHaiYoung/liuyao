import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { LlmMessage } from '../llm/types';
import type { MessageDto, MessageRole, MessageStatus, UsageDto } from '@/shared/types';
import { getChartRun, listMessageSources } from '../chart/snapshots';
import { summarizeStoredChart } from '../chart/summary';
import { buildSourceHref } from '../chat/citations';

/** 消息数据访问：用户消息、助手占位、增量落库与历史分页。 */

export interface MessageRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  client_message_id: string | null;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  rowid?: number;
}

export function toMessageDto(row: MessageRow): MessageDto {
  const hasUsage = row.input_tokens !== null || row.output_tokens !== null || row.total_tokens !== null;
  const usage: UsageDto | null = hasUsage
    ? {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
      }
    : null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    status: row.status,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    usage,
  };
}

export function findMessageById(
  db: SqliteDatabase,
  id: string,
  ownerId: string,
): MessageRow | undefined {
  return db.prepare('SELECT * FROM messages WHERE id = ? AND owner_id = ?').get(id, ownerId) as
    | MessageRow
    | undefined;
}

export function findMessageByClientId(
  db: SqliteDatabase,
  conversationId: string,
  clientMessageId: string,
): MessageRow | undefined {
  return db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?')
    .get(conversationId, clientMessageId) as MessageRow | undefined;
}

export function insertUserMessage(
  db: SqliteDatabase,
  params: {
    id: string;
    conversationId: string;
    ownerId: string;
    clientMessageId: string;
    content: string;
    now: string;
  },
): MessageRow {
  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, owner_id, client_message_id, role, content, status, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'user', ?, 'completed', ?, ?, ?)`,
  ).run(
    params.id,
    params.conversationId,
    params.ownerId,
    params.clientMessageId,
    params.content,
    params.now,
    params.now,
    params.now,
  );
  const row = findMessageById(db, params.id, params.ownerId);
  if (!row) throw new Error('写入用户消息后无法读取记录');
  return row;
}

export function insertAssistantPlaceholder(
  db: SqliteDatabase,
  params: {
    id: string;
    conversationId: string;
    ownerId: string;
    provider: string;
    model: string;
    promptVersion: string;
    now: string;
  },
): MessageRow {
  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, owner_id, client_message_id, role, content, status, provider, model, prompt_version, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'assistant', '', 'streaming', ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.conversationId,
    params.ownerId,
    params.provider,
    params.model,
    params.promptVersion,
    params.now,
    params.now,
  );
  const row = findMessageById(db, params.id, params.ownerId);
  if (!row) throw new Error('写入助手占位消息后无法读取记录');
  return row;
}

/** 流式过程中定期保存已生成文本，进程异常时仍能保留最近内容。 */
export function updateAssistantPartial(
  db: SqliteDatabase,
  messageId: string,
  content: string,
  now: string,
): void {
  db.prepare(
    "UPDATE messages SET content = ?, updated_at = ? WHERE id = ? AND status = 'streaming'",
  ).run(content, now, messageId);
}

export interface FinalizeAssistantParams {
  messageId: string;
  content: string;
  status: Extract<MessageStatus, 'completed' | 'interrupted' | 'failed'>;
  usage?: UsageDto | null;
  errorCode?: string | null;
  latencyMs?: number | null;
  model?: string | null;
  provider?: string | null;
  now: string;
}

export function finalizeAssistantMessage(db: SqliteDatabase, params: FinalizeAssistantParams): void {
  db.prepare(
    `UPDATE messages
        SET content = ?,
            status = ?,
            error_code = ?,
            input_tokens = ?,
            output_tokens = ?,
            total_tokens = ?,
            latency_ms = ?,
            model = COALESCE(?, model),
            provider = COALESCE(?, provider),
            completed_at = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    params.content,
    params.status,
    params.errorCode ?? null,
    params.usage?.inputTokens ?? null,
    params.usage?.outputTokens ?? null,
    params.usage?.totalTokens ?? null,
    params.latencyMs ?? null,
    params.model ?? null,
    params.provider ?? null,
    params.now,
    params.now,
    params.messageId,
  );
}

export function hasStreamingMessage(db: SqliteDatabase, conversationId: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM messages WHERE conversation_id = ? AND status = 'streaming' LIMIT 1")
    .get(conversationId) as { present: number } | undefined;
  return Boolean(row);
}

/**
 * 把某会话中遗留的 streaming 消息标记为 interrupted。
 * 用于自愈：库里显示“正在生成”但进程内已没有对应任务（例如上次进程被杀）。
 */
export function interruptStreamingMessages(
  db: SqliteDatabase,
  conversationId: string,
  errorCode: string,
  now: string,
): number {
  const result = db
    .prepare(
      `UPDATE messages
          SET status = 'interrupted', error_code = ?, completed_at = ?, updated_at = ?
        WHERE conversation_id = ? AND status = 'streaming'`,
    )
    .run(errorCode, now, now, conversationId);
  return result.changes;
}

export interface MessagePage {
  items: MessageDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * 阶段 4：给历史消息附上当时的来源快照与盘面摘要（旧消息为 null）。
 *
 * 快照缺失（旧库、未迁移、快照损坏）时**不抛出**：历史读取必须保持阶段 1 的可用性，
 * 只是这些字段为 null，绝不因此看不到旧消息。
 */
function attachPhase4Snapshots(db: SqliteDatabase, items: MessageDto[], rows: MessageRow[]): void {
  const byId = new Map(rows.map((row) => [row.id, row as unknown as Record<string, unknown>]));
  for (const item of items) {
    const row = byId.get(item.id);
    if (!row) continue;
    try {
      const stored = listMessageSources(db, item.id);
      item.sources =
        stored.length > 0
          ? stored.map((record) => ({
              sid: record.sid,
              sourceId: record.sourceId,
              pagePath: record.pagePath,
              locatorType: record.locatorType,
              locatorValue: record.locatorValue,
              qualityStatus: record.qualityStatus === 'needs_review' ? 'needs_review' : 'usable',
              href: buildSourceHref(record.sourceId, record.locatorType, record.locatorValue),
              label: `来源 ${record.sourceId} ${record.locatorValue ?? ''}`.trim(),
              needsQualityNotice: record.qualityStatus === 'needs_review',
            }))
          : null;
      const chartRunId = typeof row.chart_run_id === 'string' && row.chart_run_id !== '' ? row.chart_run_id : null;
      if (chartRunId === null) {
        item.chart = null;
        continue;
      }
      const run = getChartRun(db, chartRunId);
      if (!run || run.chartJson === '') {
        item.chart = null;
        continue;
      }
      const summarized = summarizeStoredChart(run.chartJson, {
        chartRunId: run.id,
        canonicalHash: run.canonicalHash,
        ruleProfileVersion: run.ruleProfileVersion,
        coreVersion: run.coreVersion,
        action: 'new',
      });
      item.chart = summarized
        ? {
            chartRunId: summarized.chartRunId,
            canonicalHash: summarized.canonicalHash,
            ruleProfileVersion: summarized.ruleProfileVersion,
            coreVersion: summarized.coreVersion,
            summary: summarized.summary,
          }
        : null;
    } catch (error) {
      console.warn('[liuyao] 读取阶段 4 快照失败，历史仍按阶段 1 字段返回', error);
      item.sources = null;
      item.chart = null;
    }
  }
}

/**
 * 历史分页：按 rowid（插入顺序）稳定排序。
 * 默认返回最近 limit 条（升序输出，便于直接渲染），游标指更早的消息。
 */
export function listMessages(
  db: SqliteDatabase,
  conversationId: string,
  options: { limit: number; beforeRowId?: number | null },
): MessagePage {
  const limit = options.limit;
  const params: unknown[] = [conversationId];
  let where = 'conversation_id = ?';
  if (typeof options.beforeRowId === 'number' && Number.isFinite(options.beforeRowId)) {
    where += ' AND rowid < ?';
    params.push(options.beforeRowId);
  }
  params.push(limit + 1);

  const rows = db
    .prepare(`SELECT *, rowid FROM messages WHERE ${where} ORDER BY rowid DESC LIMIT ?`)
    .all(...params) as MessageRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ascending = [...page].reverse();
  const oldest = ascending[0];
  const items = ascending.map(toMessageDto);
  attachPhase4Snapshots(db, items, ascending);
  return {
    items,
    nextCursor: hasMore && oldest?.rowid != null ? String(oldest.rowid) : null,
    hasMore,
  };
}

/**
 * 组装送入模型的多轮上下文：
 * 只取最近 N 条，再按字符预算从最旧开始丢弃；空内容的失败/中断助手消息跳过。
 */
export function buildModelContext(
  db: SqliteDatabase,
  conversationId: string,
  options: { messageLimit: number; charBudget: number },
): LlmMessage[] {
  const rows = db
    .prepare(
      `SELECT role, content, status FROM messages
        WHERE conversation_id = ? AND role IN ('user', 'assistant') AND status != 'streaming'
        ORDER BY rowid DESC LIMIT ?`,
    )
    .all(conversationId, options.messageLimit) as Array<{ role: MessageRole; content: string; status: MessageStatus }>;

  const ordered = [...rows].reverse().filter((row) => row.content.trim() !== '');

  // 从最新往回累积，保证最新的用户问题一定在预算内。
  const kept: LlmMessage[] = [];
  let used = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const row = ordered[i]!;
    const length = row.content.length;
    if (kept.length > 0 && used + length > options.charBudget) break;
    kept.push({ role: row.role === 'assistant' ? 'assistant' : 'user', content: row.content });
    used += length;
  }
  kept.reverse();
  return kept;
}
