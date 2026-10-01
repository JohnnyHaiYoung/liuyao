import { DEFAULT_MODEL } from '@/shared/types';
import { getConfig } from '../config';
import { DeepSeekProvider } from './deepseek';
import { FakeStreamProvider } from './fake';
import type { LlmProvider } from './types';

/**
 * 模型提供方注册表。
 * 阶段 1 只注册 DeepSeek；阶段 4 在此加入千问（qwen3.7-plus）即可，
 * 上层聊天流程与 SSE 协议保持不变。
 *
 * LIUYAO_FAKE_MODEL=1 时额外注册本地验收用假模型（见 llm/fake.ts），
 * 用于在没有真实密钥的环境里验证流式与持久化链路；默认关闭。
 */

const providers = new Map<string, LlmProvider>();

function register(provider: LlmProvider): void {
  providers.set(provider.id, provider);
}

register(new DeepSeekProvider());

export function isFakeModelEnabled(): boolean {
  return getConfig().llm.fakeMode;
}

if (isFakeModelEnabled()) {
  register(new FakeStreamProvider());
}

let fakeModeWarned = false;

/**
 * 只在真正发生调用时提示一次。
 * 刻意不放在模块加载期：打包阶段会导入本模块，模块级 stderr 输出会污染构建输出。
 */
function warnFakeModeOnce(): void {
  if (fakeModeWarned) return;
  fakeModeWarned = true;
  console.warn(
    '[liuyao] 已启用 LIUYAO_FAKE_MODEL=1：聊天由本地假模型生成，未调用 DeepSeek。仅用于验收链路，请勿用于正式使用。',
  );
}

export function getProvider(providerId: string): LlmProvider | undefined {
  return providers.get(providerId);
}

export function getDefaultProvider(): LlmProvider {
  // 验收假模型模式下默认使用假模型；正常运行时固定为 DeepSeek。
  const useFake = isFakeModelEnabled();
  if (useFake) warnFakeModeOnce();
  const preferred = useFake ? 'fake' : 'deepseek';
  const provider = providers.get(preferred);
  if (!provider) throw new Error(`未注册默认模型提供方：${preferred}`);
  return provider;
}

/** 校验请求的模型名是否属于已接入的提供方；返回 null 表示不支持。 */
export function resolveProviderForModel(modelId: string): LlmProvider | null {
  for (const provider of providers.values()) {
    if (provider.listModels().includes(modelId)) return provider;
  }
  return null;
}

export function defaultModelId(): string {
  return getDefaultProvider().defaultModel || DEFAULT_MODEL;
}

export type { LlmProvider } from './types';
