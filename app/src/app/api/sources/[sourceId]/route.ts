import type { NextRequest } from 'next/server';
import { ERROR_CODES } from '@/shared/types';
import { authenticateRequest } from '@/server/auth/session';
import { jsonError, jsonOk } from '@/server/http/api';
import { loadCatalog, resolveProjectRoot } from '@/server/wiki/catalog';
import {
  SourceAccessError,
  describeSource,
  readPage,
  readParagraph,
} from '@/server/wiki/source-reader';

/**
 * GET /api/sources/{sourceId}[?locator=¶0002|第3页|page:3]
 *
 * 登录后可读；只返回 corpus/manifest.jsonl 白名单内的来源，
 * 定位只接受 ¶NNNN 段落锚点与页码，不接受任意路径（越权一律 4xx，不泄露磁盘结构）。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ sourceId: string }>;
}

const NOT_FOUND_CODES = new Set(['unknown_source', 'locator_not_found', 'asset_not_found', 'cleaned_missing']);

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = authenticateRequest(request);
  if (!auth) return jsonError(401, ERROR_CODES.authRequired);

  const { sourceId } = await context.params;
  const locator = request.nextUrl.searchParams.get('locator');

  try {
    const projectRoot = resolveProjectRoot();
    const catalog = loadCatalog(projectRoot);
    const source = describeSource(projectRoot, sourceId, catalog);
    if (locator === null || locator.trim() === '') {
      return jsonOk({ source });
    }
    const trimmed = locator.trim();
    const fragment = trimmed.startsWith('¶')
      ? { kind: 'paragraph' as const, ...readParagraph(projectRoot, sourceId, trimmed) }
      : { kind: 'page' as const, ...readPage(projectRoot, sourceId, trimmed) };
    return jsonOk({ source, fragment });
  } catch (error) {
    if (error instanceof SourceAccessError) {
      return jsonError(NOT_FOUND_CODES.has(error.code) ? 404 : 400, NOT_FOUND_CODES.has(error.code) ? ERROR_CODES.notFound : ERROR_CODES.invalidRequest);
    }
    // 非预期错误交给框架返回 500；不在响应中回显内部信息
    throw error;
  }
}
