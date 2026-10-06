import type { NextRequest } from 'next/server';
import { ERROR_CODES, type ModelsResponse } from '@/shared/types';
import { authenticateRequest } from '@/server/auth/session';
import { jsonError, jsonOk } from '@/server/http/api';
import { listAvailableModels } from '@/server/llm/available-models';

/**
 * GET /api/models
 *
 * 登录后返回**当前真正可用**的模型清单：未配置密钥的提供方不会出现（例如未配置千问时只有 DeepSeek）。
 * 客户端据此渲染选择器；服务端在提交消息时仍会用 resolveProviderForModel 再校验一次。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const auth = authenticateRequest(request);
  if (!auth) return jsonError(401, ERROR_CODES.authRequired);

  const result = listAvailableModels();
  const body: ModelsResponse = {
    defaultModelId: result.defaultModelId,
    models: result.models.map((item) => ({
      id: item.id,
      provider: item.providerId,
      label: item.providerLabel,
      available: true,
      isDefault: item.isDefault,
    })),
  };
  return jsonOk(body);
}
