import type { NextRequest } from 'next/server';
import {
  ERROR_CODES,
  type ConversationDetailResponse,
  type DeleteConversationResponse,
  type RenameConversationRequest,
} from '@/shared/types';
import { validateTitle } from '@/server/chat/title';
import { isGenerating } from '@/server/chat/in-flight';
import { authenticateRequest } from '@/server/auth/session';
import { getDb } from '@/server/db';
import {
  deleteConversation,
  findConversationById,
  getConversationSummary,
  renameConversation,
} from '@/server/db/conversations';
import { checkSameOrigin, jsonError, jsonOk, readJsonBody } from '@/server/http/api';

/**
 * GET    /api/conversations/{id}  会话元数据（不含完整历史）
 * PATCH  /api/conversations/{id}  手动重命名标题（去首尾空白、限制长度）
 * DELETE /api/conversations/{id}  删除会话及其全部消息（硬删除，级联）
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
  const summary = getConversationSummary(getDb(), id, auth.owner.id);
  if (!summary) return jsonError(404, ERROR_CODES.notFound);

  const body: ConversationDetailResponse = { conversation: summary };
  return jsonOk(body);
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const auth = authenticateRequest(request);
  if (!auth) return jsonError(401, ERROR_CODES.authRequired);

  const { id } = await context.params;
  const db = getDb();
  const conversation = findConversationById(db, id, auth.owner.id);
  if (!conversation) return jsonError(404, ERROR_CODES.notFound);

  const parsed = await readJsonBody<RenameConversationRequest>(request);
  if (!parsed.ok) return parsed.response;

  const title = validateTitle(parsed.value.title);
  if (!title.ok) {
    return jsonError(400, ERROR_CODES.invalidRequest, { message: title.message });
  }

  const updated = renameConversation(db, id, auth.owner.id, title.value);
  if (!updated) return jsonError(404, ERROR_CODES.notFound);
  const body: ConversationDetailResponse = { conversation: updated };
  return jsonOk(body);
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const auth = authenticateRequest(request);
  if (!auth) return jsonError(401, ERROR_CODES.authRequired);

  const { id } = await context.params;
  const db = getDb();
  const conversation = findConversationById(db, id, auth.owner.id);
  if (!conversation) return jsonError(404, ERROR_CODES.notFound);

  // 正在生成时不允许删除：否则流式任务会继续往已删除的会话写状态。
  if (isGenerating(id)) {
    return jsonError(409, ERROR_CODES.generationInProgress, {
      message: '该会话正在生成回复，请先停止生成再删除。',
    });
  }

  const result = deleteConversation(db, id, auth.owner.id);
  if (!result.deleted) return jsonError(404, ERROR_CODES.notFound);

  console.info(
    `[liuyao] 已删除会话 ${id}（消息 ${result.deletedMessages} 条，标题来源 ${conversation.title_source}）`,
  );
  const body: DeleteConversationResponse = {
    deleted: true,
    id,
    deletedMessages: result.deletedMessages,
  };
  return jsonOk(body);
}
