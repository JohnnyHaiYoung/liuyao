import type { HealthzResponse } from '@/shared/types';
import { getConfig, isLlmConfigured, isOwnerConfigured } from '@/server/config';
import { peekDb } from '@/server/db';
import { jsonOk } from '@/server/http/api';

/**
 * GET /api/healthz
 * 只报告“能不能用”，不暴露密钥、绝对路径或数据库内容。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const config = getConfig();
  const database = peekDb();
  const body: HealthzResponse = {
    status: database.ok ? 'ok' : 'degraded',
    time: new Date().toISOString(),
    version: config.appVersion,
    database,
    llm: {
      configured: isLlmConfigured(),
      provider: config.llm.provider,
      model: config.llm.activeModelId,
      mode: config.llm.fakeMode ? 'fake' : 'live',
    },
    auth: { ownerConfigured: isOwnerConfigured() },
  };
  return jsonOk(body);
}
