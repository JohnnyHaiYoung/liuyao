import fs from 'node:fs';
import type { NextRequest } from 'next/server';
import { ERROR_CODES } from '@/shared/types';
import { authenticateRequest } from '@/server/auth/session';
import { jsonError } from '@/server/http/api';
import { resolveProjectRoot } from '@/server/wiki/catalog';
import { SourceAccessError, resolveAsset } from '@/server/wiki/source-reader';

/**
 * GET /api/sources/{sourceId}/assets/{asset}
 *
 * 受控原页图：只允许 `<sourceId>/page-NNN.jpg`（在 corpus/assets 白名单目录内）。
 * 需要登录；目录穿越、绝对路径、URL 编码、其它扩展名、未知来源一律 4xx。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ sourceId: string; asset: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = authenticateRequest(request);
  if (!auth) return jsonError(401, ERROR_CODES.authRequired);

  const { sourceId, asset } = await context.params;

  try {
    const projectRoot = resolveProjectRoot();
    const resolved = resolveAsset(projectRoot, sourceId, asset);
    const bytes = fs.readFileSync(resolved.absolutePath);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': resolved.contentType,
        'content-length': String(bytes.byteLength),
        // 私密内容：只允许浏览器私有缓存，避免中间层缓存用户资料
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof SourceAccessError) {
      const notFound = error.code === 'asset_not_found' || error.code === 'unknown_source';
      return jsonError(notFound ? 404 : 400, notFound ? ERROR_CODES.notFound : ERROR_CODES.invalidRequest);
    }
    throw error;
  }
}
