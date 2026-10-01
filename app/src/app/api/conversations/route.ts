import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import {
  ERROR_CODES,
  type ConversationListResponse,
  type CreateConversationRequest,
  type CreateConversationResponse,
} from '@/shared/types';
import { authenticateRequest } from '@/server/auth/session';
import { getDb } from '@/server/db';
import {
  createConversation,
  decodeCursor,
  findConversationByClientId,
  listConversations,
} from '@/server/db/conversations';
import { checkSameOrigin, jsonError, jsonOk, nowIso, readJsonBody } from '@/server/http/api';
import { normalizeClientId, parseLimit } from '@/server/http/validate';

/**
 * GET  /api/conversations  历史会话列表（按 updated_at 倒序，不含空草稿）
 * POST /api/conversations  首条消息发送前创建会话；同一 clientConversationId 幂等
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const auth = authenticateRequest(request);
  if (!auth) return jsonError(401, ERROR_CODES.authRequired);

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'), 20, 100);
  const rawCursor = url.searchParams.get('cursor');
  let cursor = null;
  if (rawCursor) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return jsonError(400, ERROR_CODES.invalidRequest, { message: 'cursor 不合法。' });
  }

  const page = listConversations(getDb(), auth.owner.id, { limit, cursor });
  const body: ConversationListResponse = { items: page.items, nextCursor: page.nextCursor };
  return jsonOk(body);
}

export async function POST(request: NextRequest): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const auth = authenticateRequest(request);
  if (!auth) return jsonError(401, ERROR_CODES.authRequired);

  const parsed = await readJsonBody<CreateConversationRequest>(request);
  if (!parsed.ok) return parsed.response;

  const clientConversationId = normalizeClientId(parsed.value.clientConversationId);
  if (!clientConversationId) {
    return jsonError(400, ERROR_CODES.invalidRequest, {
      message: 'clientConversationId 必须是 8-64 位的字母、数字、下划线或连字符。',
    });
  }

  const db = getDb();
  const existing = findConversationByClientId(db, auth.owner.id, clientConversationId);
  if (existing) {
    const body: CreateConversationResponse = {
      id: existing.id,
      title: existing.title,
      titleSource: existing.title_source,
      createdAt: existing.created_at,
      updatedAt: existing.updated_at,
      created: false,
    };
    return jsonOk(body);
  }

  const now = nowIso();
  try {
    const row = createConversation(db, {
      id: randomUUID(),
      ownerId: auth.owner.id,
      clientConversationId,
      now,
    });
    const body: CreateConversationResponse = {
      id: row.id,
      title: row.title,
      titleSource: row.title_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      created: true,
    };
    return jsonOk(body, { status: 201 });
  } catch (error) {
    // 并发重试：另一个请求已经创建了同一草稿，返回既有的那条。
    const raced = findConversationByClientId(db, auth.owner.id, clientConversationId);
    if (raced) {
      const body: CreateConversationResponse = {
        id: raced.id,
        title: raced.title,
        titleSource: raced.title_source,
        createdAt: raced.created_at,
        updatedAt: raced.updated_at,
        created: false,
      };
      return jsonOk(body);
    }
    console.error('[liuyao] 创建会话失败', error);
    return jsonError(500, ERROR_CODES.internalError);
  }
}
