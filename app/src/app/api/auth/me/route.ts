import type { NextRequest } from 'next/server';
import { ERROR_CODES, type MeResponse } from '@/shared/types';
import { authenticateRequest } from '@/server/auth/session';
import { jsonError, jsonOk, nowIso } from '@/server/http/api';

/**
 * GET /api/auth/me
 * 只返回必要的拥有者信息（id 与用户名）。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const auth = authenticateRequest(request);
  if (!auth) return jsonError(401, ERROR_CODES.authRequired);
  const body: MeResponse = { authenticated: true, owner: auth.owner };
  const response = jsonOk(body);
  response.headers.set('X-Liuyao-Time', nowIso());
  return response;
}
