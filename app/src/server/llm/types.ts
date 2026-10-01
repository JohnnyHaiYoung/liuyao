import type { UsageDto } from '@/shared/types';

/**
 * 模型适配层的边界（阶段 1）。
 *
 * 应用只看到「开始生成 / 文本增量 / 完成或失败 / 用量」四件事，
 * 上游 DeepSeek 的原始 SSE 事件不会透传给浏览器；
 * 阶段 4 接入千问时只需再实现一个 LlmProvider。
 */

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export type LlmUsage = UsageDto;

export type LlmResultStatus = 'completed' | 'interrupted' | 'failed';

export interface LlmStreamResult {
  status: LlmResultStatus;
  /** 上游实际返回的模型名（可能与请求不同，历史按实际值保存）。 */
  usedModel: string;
  usage: LlmUsage;
  /** 失败/中断时的安全错误码（见 shared/types.ts 的 ERROR_CODES）。 */
  errorCode?: string | null;
  /** 仅用于服务端日志的简短说明，不直接展示给用户。 */
  errorDetail?: string | null;
  finishReason?: string | null;
}

export interface LlmStreamOptions {
  model: string;
  messages: LlmMessage[];
  /** 客户端断开时为 aborted；适配层据此停止上游调用。 */
  signal: AbortSignal;
  maxOutputTokens?: number | null;
}

export interface LlmStreamHandlers {
  /** 每个文本增量调用一次；抛错表示下游已断开。 */
  onDelta: (text: string) => void;
  onUsage?: (usage: LlmUsage) => void;
}

export interface LlmProviderInfo {
  id: string;
  label: string;
  defaultModel: string;
}

export interface LlmProvider extends LlmProviderInfo {
  isConfigured(): boolean;
  /** 阶段 1 只暴露已确认接入的模型；千问在阶段 4 加入。 */
  listModels(): string[];
  streamChat(options: LlmStreamOptions, handlers: LlmStreamHandlers): Promise<LlmStreamResult>;
}

export const EMPTY_USAGE: LlmUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
};
