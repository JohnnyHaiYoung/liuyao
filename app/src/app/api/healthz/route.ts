import type { HealthzResponse } from '@/shared/types';
import { getConfig, isLlmConfigured } from '@/server/config';
import { findOwnerByUsername, getDb, peekDb } from '@/server/db';
import { jsonOk } from '@/server/http/api';

/**
 * GET /api/healthz
 * 只报告“能不能用”，不暴露密钥、绝对路径或数据库内容。
 *
 * auth.ownerConfigured 表示**数据库里确实存在可用的拥有者账户**，
 * 而不是“环境变量有没有写值”——后者在哈希格式错误时会给出误导性的 True。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const config = getConfig();
  const database = peekDb();
  let ownerConfigured = false;
  if (database.ok) {
    try {
      ownerConfigured = Boolean(findOwnerByUsername(getDb(), config.owner.username));
    } catch {
      ownerConfigured = false;
    }
  }
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
    auth: { ownerConfigured },
  };
  return jsonOk(body);
}
