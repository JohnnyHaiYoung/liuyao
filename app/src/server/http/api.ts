import { NextResponse } from 'next/server';
import { errorMessageFor, type ApiErrorBody } from '@/shared/types';
import { getConfig } from '../config';

/** 普通 JSON 接口的统一响应工具：错误结构固定为 { error: { code, message } }。 */

export function jsonOk<T>(data: T, init?: { status?: number; headers?: Record<string, string> }): NextResponse {
  const response = NextResponse.json(data, { status: init?.status ?? 200 });
  // 显式声明 charset：部分命令行客户端（如 Windows PowerShell 5.1）在缺少 charset 时
  // 会把 UTF-8 正文按 latin-1 解码，中文变成乱码。
  response.headers.set('Content-Type', 'application/json; charset=utf-8');
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
  response.headers.set('Content-Type', 'application/json; charset=utf-8');
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
 *
 * `X-Forwarded-Host` 只在显式信任反向代理时才采信，否则客户端可以自行伪造它来配对
 * 伪造的 Origin，从而绕过同源检查。
 */
export function checkSameOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const originHost = hostOf(origin);
  if (!originHost) {
    return jsonError(403, 'forbidden_origin', { message: 'Origin 头不合法。' });
  }
  const trustProxy = isProxyTrusted();
  const hostHeader = trustProxy
    ? (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '')
    : (request.headers.get('host') ?? '');
  const requestHost = hostHeader.split(',')[0]?.trim().toLowerCase();
  if (!requestHost || originHost !== requestHost) {
    return jsonError(403, 'forbidden_origin');
  }
  return null;
}

const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_PATTERN = /^[0-9a-fA-F:]{2,45}$/;

function isIpLiteral(value: string): boolean {
  if (IPV4_PATTERN.test(value)) {
    return value.split('.').every((part) => Number.parseInt(part, 10) <= 255);
  }
  return IPV6_PATTERN.test(value);
}

export interface ClientIdentity {
  /** 限流分桶键。不可信来源统一落到 "direct" 桶，避免伪造唯一值刷爆计数表。 */
  key: string;
  source: 'direct' | 'trusted-proxy';
  /** 收到转发头但因为未开启信任而被忽略。 */
  forwardedIgnored: boolean;
}

export function isProxyTrusted(): boolean {
  return getConfig().http.trustProxy;
}

/**
 * 判断请求来源，用于登录/发送限流。
 *
 * 信任模型（验收报告 2026-10-02 第 2 条修复点）：
 *   - 默认**不信任**任何转发头：`X-Forwarded-For`/`X-Real-IP` 都可以由客户端伪造，
 *     而 Next 的 Route Handler 拿不到 socket 地址，因此统一使用单个 "direct" 桶。
 *     单用户私有部署下这是安全的选择（代价：限流是全局计数而非按 IP，见交付说明）。
 *   - 只有显式设置 `LIUYAO_TRUST_PROXY=1`（前提：应用只监听回环、且反向代理负责
 *     **覆盖**写入 `X-Real-IP`）才按代理给出的地址分桶；此时取 `X-Real-IP`，
 *     缺失时取 `X-Forwarded-For` 的**最后一段**（由最近一跳代理追加），绝不取第一段。
 */
export function clientIdentity(request: Request): ClientIdentity {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const hasForwardedHeader = Boolean(forwardedFor || realIp);

  if (!isProxyTrusted()) {
    return { key: 'direct', source: 'direct', forwardedIgnored: hasForwardedHeader };
  }

  const candidates: string[] = [];
  if (realIp) candidates.push(...realIp.split(',').map((part) => part.trim()));
  if (forwardedFor) {
    const parts = forwardedFor.split(',').map((part) => part.trim());
    const last = parts[parts.length - 1];
    if (last) candidates.push(last);
  }
  for (const candidate of candidates) {
    if (candidate && isIpLiteral(candidate)) {
      return { key: `proxy:${candidate}`, source: 'trusted-proxy', forwardedIgnored: false };
    }
  }
  return { key: 'direct', source: 'trusted-proxy', forwardedIgnored: false };
}

let forwardedIgnoreWarned = false;

/** 未开启代理信任却收到转发头时提示一次，便于发现部署配置问题。 */
export function warnIfForwardedIgnored(identity: ClientIdentity): void {
  if (!identity.forwardedIgnored || forwardedIgnoreWarned) return;
  forwardedIgnoreWarned = true;
  console.warn(
    '[liuyao] 收到 X-Forwarded-For/X-Real-IP 但未启用 LIUYAO_TRUST_PROXY，已忽略这些头并按单一来源限流。' +
      '若服务部署在反向代理之后，请把应用绑定到 127.0.0.1，并在代理中覆盖写入 X-Real-IP 后设置 LIUYAO_TRUST_PROXY=1。',
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}
