import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import type { OwnerInfo } from '@/shared/types';
import { getConfig } from '../config';
import { getDb, findOwnerById } from '../db';
import { createSession, extendSession, findActiveSession, revokeSession, touchSession } from '../db/sessions';

/**
 * 登录态。
 *
 * - Cookie 里只有 32 字节随机令牌（base64url），HttpOnly + SameSite=Lax。
 * - 数据库只保存令牌的 SHA-256，泄库不能直接复用登录态。
 * - Secure 默认按请求协议自动判断：HTTPS 环境自动加 Secure，
 *   本地 HTTP 联调不会因为 Secure 反而登录不上；可用 LIUYAO_COOKIE_SECURE 强制。
 */

export interface AuthContext {
  owner: OwnerInfo;
  sessionId: string;
  expiresAt: string;
}

export const SESSION_COOKIE_MAX_AGE_MARGIN_MS = 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: string;
}

export function startSession(ownerId: string, userAgent: string | null): CreatedSession {
  const db = getDb();
  const config = getConfig();
  const token = generateSessionToken();
  const sessionId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.session.ttlMs).toISOString();
  createSession(db, {
    id: sessionId,
    ownerId,
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    expiresAt,
    userAgent,
  });
  return { token, sessionId, expiresAt };
}

export function endSession(sessionId: string): void {
  revokeSession(getDb(), sessionId, new Date().toISOString());
}

function authenticateToken(token: string): AuthContext | null {
  const db = getDb();
  const config = getConfig();
  const now = new Date();
  const row = findActiveSession(db, hashToken(token), now.toISOString());
  if (!row) return null;
  const owner = findOwnerById(db, row.owner_id);
  if (!owner) return null;

  // 滑动续期：剩余有效期不足一半时才写库，避免每个请求都产生写操作。
  const expiresAtMs = Date.parse(row.expires_at);
  if (Number.isFinite(expiresAtMs) && expiresAtMs - now.getTime() < config.session.ttlMs / 2) {
    const nextExpiry = new Date(now.getTime() + config.session.ttlMs).toISOString();
    extendSession(db, row.id, nextExpiry);
    touchSession(db, row.id, now.toISOString());
    return { owner: { id: owner.id, username: owner.username }, sessionId: row.id, expiresAt: nextExpiry };
  }
  touchSession(db, row.id, now.toISOString());
  return {
    owner: { id: owner.id, username: owner.username },
    sessionId: row.id,
    expiresAt: row.expires_at,
  };
}

function readCookieToken(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      const value = trimmed.slice(name.length + 1);
      return value === '' ? null : decodeURIComponent(value);
    }
  }
  return null;
}

/** 供 Route Handler 使用：直接从请求头解析 Cookie，避免额外的异步上下文。 */
export function authenticateRequest(request: Request): AuthContext | null {
  const { cookieName } = getConfig().session;
  const token = readCookieToken(request.headers.get('cookie'), cookieName);
  if (!token) return null;
  return authenticateToken(token);
}

/** 供服务端组件使用（page.tsx）。 */
export async function authenticateCookies(): Promise<AuthContext | null> {
  const { cookieName } = getConfig().session;
  const store = await cookies();
  const token = store.get(cookieName)?.value;
  if (!token) return null;
  return authenticateToken(token);
}

/** 按请求协议决定是否加 Secure（反向代理下读取 x-forwarded-proto）。 */
export function isSecureRequest(request: Request): boolean {
  const { secureMode } = getConfig().session;
  if (secureMode === 'always') return true;
  if (secureMode === 'never') return false;
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    return forwardedProto.split(',')[0]?.trim().toLowerCase() === 'https';
  }
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function setSessionCookie(response: NextResponse, request: Request, session: CreatedSession): void {
  const { cookieName } = getConfig().session;
  response.cookies.set({
    name: cookieName,
    value: session.token,
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(request),
    path: '/',
    maxAge: Math.floor(getConfig().session.ttlMs / 1000),
  });
}

export function clearSessionCookie(response: NextResponse): void {
  const { cookieName } = getConfig().session;
  response.cookies.set({
    name: cookieName,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
