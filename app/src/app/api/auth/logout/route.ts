import type { NextRequest } from 'next/server';
import { authenticateRequest, clearSessionCookie, endSession } from '@/server/auth/session';
import { jsonError, checkSameOrigin, jsonOk } from '@/server/http/api';

/**
 * POST /api/auth/logout
 * 撤销当前服务端会话并清除 Cookie；未登录时也返回成功（幂等）。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const auth = authenticateRequest(request);
  if (auth) {
    endSession(auth.sessionId);
  }
  const response = jsonOk({ loggedOut: true });
  clearSessionCookie(response);
  return response;
}

export function GET(): Response {
  return jsonError(405, 'invalid_request', { message: '请使用 POST 退出登录。' });
}
