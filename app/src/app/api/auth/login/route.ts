import { NextResponse, type NextRequest } from 'next/server';
import { ERROR_CODES, type LoginRequest, type LoginResponse } from '@/shared/types';
import { dummyVerify, verifyPassword } from '@/server/auth/password';
import { isSecureRequest, setSessionCookie, startSession } from '@/server/auth/session';
import { getConfig } from '@/server/config';
import { findOwnerByUsername, getDb } from '@/server/db';
import { purgeStaleSessions } from '@/server/db/sessions';
import { checkSameOrigin, clientIp, jsonError, jsonOk, readJsonBody } from '@/server/http/api';
import { consume, reset } from '@/server/http/rate-limit';

/**
 * POST /api/auth/login
 * 密码只来自请求体；校验用 scrypt 哈希。失败一律返回同一个错误，
 * 不泄露密码、哈希或“账户是否存在”。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const config = getConfig();
  const ip = clientIp(request);
  const limitKey = `login:${ip}`;
  const limit = consume(limitKey, config.limits.loginMaxAttempts, config.limits.loginWindowMs);
  if (!limit.allowed) {
    return jsonError(429, ERROR_CODES.rateLimited, {
      message: `登录尝试过于频繁，请 ${limit.retryAfterSeconds} 秒后再试。`,
      details: { retryAfterSeconds: limit.retryAfterSeconds },
    });
  }

  const body = await readJsonBody<LoginRequest>(request);
  if (!body.ok) return body.response;
  const password = typeof body.value.password === 'string' ? body.value.password : '';

  const db = getDb();
  const owner = findOwnerByUsername(db, config.owner.username);
  if (!owner) {
    // 库里没有账户：可能是没配环境变量，也可能是哈希格式不可用（启动日志会说明原因）。
    dummyVerify(password);
    console.warn('[liuyao] 登录失败：服务器尚未建立拥有者账户。');
    return jsonError(503, ERROR_CODES.authNotConfigured);
  }

  const passwordOk = verifyPassword(password, owner.password_hash);
  if (!passwordOk) {
    dummyVerify(password);
    // 只记录失败事件与来源，不记录尝试的密码。
    console.warn(`[liuyao] 登录失败 ip=${ip}`);
    return jsonError(401, ERROR_CODES.invalidCredentials);
  }

  reset(limitKey);
  const session = startSession(owner.id, request.headers.get('user-agent'));
  // 顺手清理过期/已撤销会话，避免表无限增长。
  purgeStaleSessions(db, new Date().toISOString(), new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());

  const payload: LoginResponse = {
    owner: { id: owner.id, username: owner.username },
    expiresAt: session.expiresAt,
  };
  const response = jsonOk(payload);
  setSessionCookie(response, request, session);
  console.info(
    `[liuyao] 登录成功 user=${owner.username} secure=${isSecureRequest(request)} ip=${ip}`,
  );
  return response;
}
