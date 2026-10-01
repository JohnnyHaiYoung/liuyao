import { NextResponse } from 'next/server';
import { errorMessageFor, type ApiErrorBody } from '@/shared/types';

/** 普通 JSON 接口的统一响应工具：错误结构固定为 { error: { code, message } }。 */

export function jsonOk<T>(data: T, init?: { status?: number; headers?: Record<string, string> }): NextResponse {
  const response = NextResponse.json(data, { status: init?.status ?? 200 });
  response.headers.set('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(init?.headers ?? {})) {
    response.headers.set(key, value);
  }
  return response;
}

export function jsonError(
  status: number,
  code: string,
  options?: { message?: string; details?: Record<string, unknown> },
): NextResponse {
  const body: ApiErrorBody = {
    error: {
      code,
      message: options?.message ?? errorMessageFor(code),
      ...(options?.details ? { details: options.details } : {}),
    },
  };
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export type BodyResult<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

/** 解析 JSON 请求体；限制大小，失败返回统一错误。 */
export async function readJsonBody<T>(request: Request, maxBytes = 256 * 1024): Promise<BodyResult<T>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      response: jsonError(415, 'invalid_request', { message: '请求体必须是 application/json。' }),
    };
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    return { ok: false, response: jsonError(413, 'invalid_request', { message: '请求体过大。' }) };
  }
  if (text.trim() === '') {
    return { ok: false, response: jsonError(400, 'invalid_request', { message: '请求体为空。' }) };
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, response: jsonError(400, 'invalid_request', { message: '请求体不是合法 JSON。' }) };
  }
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 跨站请求保护（配合 Cookie 的 SameSite=Lax）：
 * 浏览器发出的跨站请求会带 Origin；与本站 Host 不一致时拒绝。
 * 不带 Origin 的请求（curl、验收脚本等非浏览器客户端）放行，由登录 Cookie 决定权限。
 */
export function checkSameOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const originHost = hostOf(origin);
  if (!originHost) {
    return jsonError(403, 'forbidden_origin', { message: 'Origin 头不合法。' });
  }
  const requestHost = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  if (!requestHost || originHost !== requestHost) {
    return jsonError(403, 'forbidden_origin');
  }
  return null;
}

/** 登录限流按来源地址分组；反向代理下优先取 X-Forwarded-For 的第一段。 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}

export function nowIso(): string {
  return new Date().toISOString();
}
