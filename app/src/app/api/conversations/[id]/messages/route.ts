import type { NextRequest } from 'next/server';
import { ERROR_CODES, type ChatRequest, type MessageListResponse } from '@/shared/types';
import { authenticateRequest } from '@/server/auth/session';
import { startChatStream } from '@/server/chat/stream-service';
import { getConfig } from '@/server/config';
import { getDb } from '@/server/db';
import { findConversationById } from '@/server/db/conversations';
import { listMessages } from '@/server/db/messages';
import { checkSameOrigin, jsonError, jsonOk, readJsonBody } from '@/server/http/api';
import { consume } from '@/server/http/rate-limit';
import { normalizeClientId, normalizeModelId, parseBeforeRowId, parseLimit, validateContent } from '@/server/http/validate';

/**
 * GET  /api/conversations/{id}/messages  历史消息分页（顺序稳定，含生成状态）
 * POST /api/conversations/{id}/messages  提交问题，返回规范化 SSE 流
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = authenticateRequest(request);
  if (!auth) return jsonError(401, ERROR_CODES.authRequired);

  const { id } = await context.params;
  const db = getDb();
  const conversation = findConversationById(db, id, auth.owner.id);
  if (!conversation) return jsonError(404, ERROR_CODES.notFound);

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), 50, 200);
  const before = parseBeforeRowId(url.searchParams.get('before'));
  const page = listMessages(db, id, { limit, beforeRowId: before });

  const body: MessageListResponse = {
    items: page.items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
  return jsonOk(body);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const auth = authenticateRequest(request);
  if (!auth) return jsonError(401, ERROR_CODES.authRequired);

  const { id } = await context.params;
  const config = getConfig();
  const db = getDb();
  const conversation = findConversationById(db, id, auth.owner.id);
  if (!conversation) return jsonError(404, ERROR_CODES.notFound);

  const limit = consume(
    `send:${auth.owner.id}`,
    config.limits.sendsPerMinute,
    60 * 1000,
  );
  if (!limit.allowed) {
    return jsonError(429, ERROR_CODES.rateLimited, {
      message: `发送过于频繁，请 ${limit.retryAfterSeconds} 秒后再试。`,
      details: { retryAfterSeconds: limit.retryAfterSeconds },
    });
  }

  const parsed = await readJsonBody<ChatRequest>(request);
  if (!parsed.ok) return parsed.response;

  const clientMessageId = normalizeClientId(parsed.value.clientMessageId);
  if (!clientMessageId) {
    return jsonError(400, ERROR_CODES.invalidRequest, {
      message: 'clientMessageId 必须是 8-64 位的字母、数字、下划线或连字符。',
    });
  }
  const content = validateContent(parsed.value.content, config.chat.maxMessageChars);
  if (!content.ok) {
    return jsonError(400, ERROR_CODES.invalidRequest, { message: content.message });
  }

  const outcome = startChatStream({
    ownerId: auth.owner.id,
    conversationId: id,
    clientMessageId,
    content: content.value,
    requestedModel: normalizeModelId(parsed.value.model),
    clientSignal: request.signal,
    chartInput: parsed.value.chartInput ?? null,
    chartAction: parsed.value.chartAction === 'new' ? 'new' : 'auto',
  });

  if (!outcome.ok) {
    return jsonError(outcome.status, outcome.code, {
      ...(outcome.message ? { message: outcome.message } : {}),
      ...(outcome.details ? { details: outcome.details } : {}),
    });
  }
  return outcome.response;
}
