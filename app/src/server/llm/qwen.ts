import { ERROR_CODES } from '@/shared/types';
import {
  EMPTY_USAGE,
  type LlmProvider,
  type LlmStreamHandlers,
  type LlmStreamOptions,
  type LlmStreamResult,
  type LlmUsage,
} from './types';

/**
 * 阿里云百炼（DashScope）OpenAI 兼容模式适配器：qwen3.7-plus（阶段 4）。
 *
 * 设计约束（任务书第 5 节）：
 *   - **只有**配置了密钥（QWEN_API_KEY 或 DASHSCOPE_API_KEY）时才可选；未配置时 listModels()
 *     返回空数组，服务端的 resolveProviderForModel 会返回 null，请求方得到明确错误，
 *     默认 DeepSeek **不受影响**。
 *   - 终止、错误与用量由**本适配器自己解析**：DashScope 的兼容模式虽然形状接近 OpenAI/DeepSeek，
 *     但结束标记、错误体与用量位置都可能不同，因此这里独立实现，不共用 DeepSeek 的判断函数。
 *   - 同样遵守阶段 1 的严格终止语义：只有同时满足「收到 [DONE]」与「结束原因可接受」才记 completed；
 *     提前 EOF、连接中断、上游报错、缺少结束原因都记 failed/interrupted，并保留已生成正文。
 *   - 密钥只在服务器环境变量与请求头中使用，不写日志、不进事件。
 *
 * 环境变量：
 *   QWEN_API_KEY | DASHSCOPE_API_KEY   必填（缺失即不可选）
 *   QWEN_BASE_URL                      可选，默认阿里云兼容模式地址
 *   QWEN_MODEL                         可选，默认 qwen3.7-plus
 */

export const QWEN_MODEL_ID = 'qwen3.7-plus';
export const DEFAULT_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

interface DashScopeChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
    index?: number;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  output?: { text?: string | null; finish_reason?: string | null };
  code?: string;
  message?: string;
  request_id?: string;
  error?: { code?: string; message?: string } | null;
  model?: string;
}

/** DashScope 兼容模式可接受的正常结束原因（仍需同时收到 [DONE]）。 */
const ACCEPTABLE_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'null']);

function readEnv(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function qwenApiKey(): string {
  return readEnv('QWEN_API_KEY') || readEnv('DASHSCOPE_API_KEY');
}

export function qwenBaseUrl(): string {
  return readEnv('QWEN_BASE_URL') || DEFAULT_QWEN_BASE_URL;
}

export function qwenModelId(): string {
  return readEnv('QWEN_MODEL') || QWEN_MODEL_ID;
}

function toUsage(raw: DashScopeChunk['usage']): LlmUsage {
  if (!raw) return { ...EMPTY_USAGE };
  return {
    inputTokens: typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : null,
    outputTokens: typeof raw.completion_tokens === 'number' ? raw.completion_tokens : null,
    totalTokens: typeof raw.total_tokens === 'number' ? raw.total_tokens : null,
  };
}

/** DashScope 错误分类：兼容模式返回 OpenAI 形状，也可能返回 DashScope 的 code/message。 */
export function classifyQwenError(status: number, body: DashScopeChunk | null): { code: string; detail: string } {
  const upstreamCode = body?.error?.code ?? body?.code ?? '';
  const detail = body?.error?.message ?? body?.message ?? `HTTP ${status}`;
  if (status === 401 || status === 403) return { code: ERROR_CODES.upstreamAuthError, detail };
  if (status === 429) return { code: ERROR_CODES.upstreamRateLimited, detail };
  if (status === 408 || status === 504) return { code: ERROR_CODES.upstreamTimeout, detail };
  if (status === 400 && /Arrearage|QuotaExhausted|insufficient|balance/i.test(`${upstreamCode} ${detail}`)) {
    return { code: ERROR_CODES.upstreamInsufficientBalance, detail };
  }
  if (status >= 500) return { code: ERROR_CODES.upstreamUnavailable, detail };
  if (status >= 400) return { code: ERROR_CODES.upstreamBadRequest, detail };
  return { code: ERROR_CODES.upstreamError, detail };
}

export class QwenProvider implements LlmProvider {
  readonly id = 'qwen';
  readonly label = '阿里云百炼（千问）';
  readonly defaultModel = QWEN_MODEL_ID;

  isConfigured(): boolean {
    return qwenApiKey() !== '';
  }

  listModels(): string[] {
    // 未配置密钥时不列出：服务端据此拒绝选择，客户端也不会看到
    return this.isConfigured() ? [qwenModelId()] : [];
  }

  async streamChat(options: LlmStreamOptions, handlers: LlmStreamHandlers): Promise<LlmStreamResult> {
    const apiKey = qwenApiKey();
    const model = options.model || qwenModelId();
    if (apiKey === '') {
      return {
        status: 'failed',
        usedModel: model,
        usage: { ...EMPTY_USAGE },
        errorCode: ERROR_CODES.llmNotConfigured,
        errorDetail: '未配置 QWEN_API_KEY / DASHSCOPE_API_KEY',
      };
    }

    const body: Record<string, unknown> = {
      model,
      messages: options.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (typeof options.maxOutputTokens === 'number' && options.maxOutputTokens > 0) {
      body.max_tokens = options.maxOutputTokens;
    }

    let response: Response;
    try {
      response = await fetch(`${qwenBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      const aborted = options.signal.aborted;
      return {
        status: aborted ? 'interrupted' : 'failed',
        usedModel: model,
        usage: { ...EMPTY_USAGE },
        errorCode: aborted ? ERROR_CODES.clientAborted : ERROR_CODES.upstreamUnavailable,
        errorDetail: error instanceof Error ? error.message : String(error),
      };
    }

    if (!response.ok || !response.body) {
      let parsed: DashScopeChunk | null = null;
      try {
        parsed = (await response.json()) as DashScopeChunk;
      } catch {
        parsed = null;
      }
      const classified = classifyQwenError(response.status, parsed);
      return {
        status: options.signal.aborted ? 'interrupted' : 'failed',
        usedModel: model,
        usage: { ...EMPTY_USAGE },
        errorCode: options.signal.aborted ? ERROR_CODES.clientAborted : classified.code,
        errorDetail: classified.detail,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage: LlmUsage = { ...EMPTY_USAGE };
    let finishReason: string | null = null;
    let sawDone = false;
    let usedModel = model;
    let streamError: { code: string; detail: string } | null = null;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const rawLine = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          const line = rawLine.replace(/\r$/, '');
          if (line === '' || line.startsWith(':') || line.startsWith('event:')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' ) continue;
          if (payload === '[DONE]') {
            sawDone = true;
            continue;
          }
          let chunk: DashScopeChunk;
          try {
            chunk = JSON.parse(payload) as DashScopeChunk;
          } catch {
            // 无法解析的块按损坏处理：不谎报完成
            streamError = { code: ERROR_CODES.upstreamError, detail: '无法解析的上游 SSE 数据块' };
            continue;
          }
          if (chunk.error || chunk.code) {
            const classified = classifyQwenError(200, chunk);
            streamError = { code: classified.code, detail: classified.detail };
            continue;
          }
          if (typeof chunk.model === 'string' && chunk.model !== '') usedModel = chunk.model;
          const choice = chunk.choices?.[0];
          const deltaText = choice?.delta?.content ?? chunk.output?.text ?? null;
          if (typeof deltaText === 'string' && deltaText !== '') {
            text += deltaText;
            handlers.onDelta(deltaText);
          }
          if (choice?.finish_reason != null) finishReason = choice.finish_reason;
          const outputFinish = chunk.output?.finish_reason;
          if (outputFinish != null) finishReason = outputFinish;
          if (chunk.usage) {
            usage = toUsage(chunk.usage);
            handlers.onUsage?.(usage);
          }
        }
      }
    } catch (error) {
      return {
        status: options.signal.aborted ? 'interrupted' : 'failed',
        usedModel,
        usage,
        errorCode: options.signal.aborted ? ERROR_CODES.clientAborted : ERROR_CODES.upstreamError,
        errorDetail: error instanceof Error ? error.message : String(error),
        finishReason,
      };
    }

    if (streamError) {
      return { status: 'failed', usedModel, usage, errorCode: streamError.code, errorDetail: streamError.detail, finishReason };
    }
    // 严格终止语义：必须同时收到 [DONE] 与可接受的结束原因
    const acceptableFinish = finishReason === null ? false : ACCEPTABLE_FINISH_REASONS.has(String(finishReason));
    if (!sawDone || !acceptableFinish) {
      return {
        status: 'failed',
        usedModel,
        usage,
        errorCode: ERROR_CODES.upstreamError,
        errorDetail: `流未正常结束（[DONE]=${sawDone}，finish_reason=${String(finishReason)}）`,
        finishReason,
      };
    }
    return { status: 'completed', usedModel, usage, errorCode: null, errorDetail: null, finishReason };
  }
}
