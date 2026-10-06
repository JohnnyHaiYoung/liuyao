import { DEFAULT_MODEL } from '@/shared/types';
import { getDefaultProvider, listRegisteredProviders } from './index';

/**
 * 可选择的模型清单（阶段 4）。
 *
 * 单一实现在此，路由只是薄封装，便于离线自检：
 *   - 只有 provider.listModels() 非空的提供方才出现在清单里（未配置密钥的千问不出现）；
 *   - 默认模型始终是 DeepSeek 的 deepseek-flash（未配置千问不影响默认）；
 *   - 客户端据此渲染选择器；即使客户端被篡改，服务端仍会再次校验（resolveProviderForModel）。
 */
export interface AvailableModelInfo {
  id: string;
  providerId: string;
  providerLabel: string;
  isDefault: boolean;
}

export interface AvailableModelsResult {
  defaultModelId: string;
  models: AvailableModelInfo[];
}

export function listAvailableModels(): AvailableModelsResult {
  const defaultProvider = getDefaultProvider();
  const defaultModelId = defaultProvider.defaultModel || DEFAULT_MODEL;
  const models: AvailableModelInfo[] = [];
  for (const provider of listRegisteredProviders()) {
    for (const id of provider.listModels()) {
      models.push({
        id,
        providerId: provider.id,
        providerLabel: provider.label,
        isDefault: id === defaultModelId,
      });
    }
  }
  return { defaultModelId, models };
}
