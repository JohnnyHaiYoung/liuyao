import { ERROR_CODES } from '@/shared/types';
import { getConfig } from '../config';
import {
  EMPTY_USAGE,
  type LlmProvider,
  type LlmStreamHandlers,
  type LlmStreamOptions,
  type LlmStreamResult,
  type LlmUsage,
} from './types';

/**
 * DeepSeek 官方 Chat Completions 适配器（阶段 1）。
 *
 * - 固定 `stream: true`，并请求 `stream_options.include_usage`。
 * - 上游 SSE 增量在这里被转换为本项目的事件语义，绝不原样透传给浏览器。
 * - API Key 只存在于服务器环境变量与本次请求头中，不写日志、不进事件。
 *
 * 终止语义（验收报告 2026-10-02 第 1 条修复点）：
 *   只有**同时**满足「收到 `data: [DONE]` 终止标记」且「结束原因可接受」才算 completed；
 *   缺少任一条件（提前 EOF、连接被重置、上游报错、没有 finish_reason）都记为 failed，
 *   并保留已经生成的部分正文，由上层写入数据库并告知页面。
 */

interface DeepSeekChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  model?: string;
}

/** 可接受的正常结束原因（必须同时收到 [DONE] 才会记为 completed）。 */
const ACCEPTABLE_FINISH_REASONS = new Set(['stop', 'tool_calls', 'length']);

function toUsage(raw: DeepSeekChunk['usage']): LlmUsage {
  if (!raw) return { ...EMPTY_USAGE };
  return {
    inputTokens: typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : null,
    outputTokens: typeof raw.completion_tokens === 'number' ? raw.completion_tokens : null,
    totalTokens: typeof raw.total_tokens === 'number' ? raw.total_tokens : null,
  };
}

function classifyHttpStatus(status: number): string {
  if (status === 401 || status === 403) return ERROR_CODES.upstreamAuthError;
  if (status === 402) return ERROR_CODES.upstreamInsufficientBalance;
  if (status === 429) return ERROR_CODES.upstreamRateLimited;
  if (status === 408 || status === 504) return ERROR_CODES.upstreamTimeout;
  if (status >= 500) return ERROR_CODES.upstreamUnavailable;
  if (status >= 400) return ERROR_CODES.upstreamBadRequest;
  return ERROR_CODES.upstreamError;
}

export class DeepSeekProvider implements LlmProvider {
  readonly id = 'deepseek';
  readonly label = 'DeepSeek';
  readonly defaultModel = 'deepseek-flash';

  isConfigured(): boolean {
    return Boolean(getConfig().llm.apiKey);
  }

  listModels(): string[] {
    // 只列出本项目已确认接入并测试过的模型；千问在阶段 4 加入。
    return ['deepseek-flash'];
  }

  async streamChat(options: LlmStreamOptions, handlers: LlmStreamHandlers): Promise<LlmStreamResult> {
    const config = getConfig();
    const apiKey = config.llm.apiKey;
    if (!apiKey) {
      return {
        status: 'failed',
        usedModel: options.model,
        usage: { ...EMPTY_USAGE },
        errorCode: ERROR_CODES.llmNotConfigured,
        errorDetail: 'DEEPSEEK_API_KEY 未配置',
      };
    }

    const started = Date.now();
    let timedOut = false;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, config.llm.timeoutMs);

    const compositeSignal = AbortSignal.any([options.signal, timeoutController.signal]);

    let usage: LlmUsage = { ...EMPTY_USAGE };
    let usedModel = options.model;
    let finishReason: string | null = null;
    /** 是否收到上游的 `data: [DONE]` 终止标记。 */
    let sawDone = false;

    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages,
      stream: true,
      stream_options: { include_usage: true },
      // 思考模式：默认 high（与 .env.example 一致），设为 none 可关闭以降低首字延迟。
      reasoning_effort: config.llm.reasoningEffort,
    };
    if (options.maxOutputTokens) {
      body.max_tokens = options.maxOutputTokens;
    }

    try {
      const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: compositeSignal,
      });

      if (!response.ok || !response.body) {
        const errorCode = classifyHttpStatus(response.status);
        const detail = await safeReadErrorBody(response);
        return {
          status: 'failed',
          usedModel,
          usage,
          errorCode,
          errorDetail: `上游 HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          finishReason: null,
        };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      readLoop: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // stream: true 让解码器自行处理跨分块的 UTF-8 字符。
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');

          if (line === '' || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            sawDone = true;
            // 跳出内层解析与外层读取：收到终止标记后不再等待 EOF。
            break readLoop;
          }

          let chunk: DeepSeekChunk;
          try {
            chunk = JSON.parse(payload) as DeepSeekChunk;
          } catch {
            continue; // 忽略无法解析的保活/注释块
          }

          if (chunk.model) usedModel = chunk.model;
          if (chunk.usage) {
            usage = toUsage(chunk.usage);
            handlers.onUsage?.(usage);
          }

          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;

          // 思考模式的推理内容与正文分开：阶段 1 只把正文推给页面，
          // 推理 token 仍计入用量（usage）。
          const text = choice?.delta?.content;
          if (typeof text === 'string' && text.length > 0) {
            handlers.onDelta(text);
          }
        }
      }

      if (sawDone) {
        // 已经拿到终止标记，不必再等上游关闭连接。
        try {
          await reader.cancel();
        } catch {
          /* 连接可能已由上游关闭 */
        }
      }

      const latencyMs = Date.now() - started;

      // 1) 上游明确给出的终止性原因，优先处理。
      if (finishReason === 'content_filter') {
        return { status: 'failed', usedModel, usage, errorCode: ERROR_CODES.contentFiltered, finishReason };
      }
      if (finishReason === 'insufficient_system_resource') {
        return {
          status: 'failed',
          usedModel,
          usage,
          errorCode: ERROR_CODES.upstreamUnavailable,
          errorDetail: '上游报告 insufficient_system_resource',
          finishReason,
        };
      }
      if (finishReason === 'aborted') {
        return {
          status: 'interrupted',
          usedModel,
          usage,
          errorCode: ERROR_CODES.clientAborted,
          finishReason,
        };
      }

      // 2) 终止标记与结束原因缺一不可；否则视为被截断，绝不谎报完成。
      if (!sawDone || finishReason === null) {
        return {
          status: 'failed',
          usedModel,
          usage,
          errorCode: ERROR_CODES.upstreamTruncated,
          errorDetail:
            `上游响应未正常结束：sawDone=${sawDone} finishReason=${finishReason ?? 'null'}` +
            ` latency=${latencyMs}ms`,
          finishReason,
        };
      }
      if (!ACCEPTABLE_FINISH_REASONS.has(finishReason)) {
        return {
          status: 'failed',
          usedModel,
          usage,
          errorCode: ERROR_CODES.upstreamTruncated,
          errorDetail: `上游结束原因不可接受：${finishReason}`,
          finishReason,
        };
      }

      // 3) 正常完成；被 max_tokens 截断时保留 completed 但带上明确标记。
      if (finishReason === 'length') {
        return {
          status: 'completed',
          usedModel,
          usage,
          errorCode: ERROR_CODES.outputLimitReached,
          finishReason,
          errorDetail: `输出达到长度上限（latency ${latencyMs}ms）`,
        };
      }
      return { status: 'completed', usedModel, usage, finishReason };
    } catch (error) {
      const aborted = isAbortError(error);
      if (aborted && options.signal.aborted && !timedOut) {
        return {
          status: 'interrupted',
          usedModel,
          usage,
          errorCode: ERROR_CODES.clientAborted,
          errorDetail: '客户端断开或用户停止生成',
        };
      }
      if (timedOut) {
        return {
          status: 'failed',
          usedModel,
          usage,
          errorCode: ERROR_CODES.upstreamTimeout,
          errorDetail: `上游请求超过 ${config.llm.timeoutMs}ms 未完成`,
        };
      }
      return {
        status: 'failed',
        usedModel,
        usage,
        errorCode: ERROR_CODES.upstreamError,
        errorDetail: describeError(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** 读取上游错误响应，只保留很短的片段供服务端日志使用。 */
async function safeReadErrorBody(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    return redactSecrets(text.replace(/\s+/g, ' ')).slice(0, 300);
  } catch {
    return null;
  }
}

/**
 * 上游错误信息可能回显请求头里的密钥片段。
 * 任何进入日志的文本都先做一次脱敏，避免密钥落盘。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer ***');
}
