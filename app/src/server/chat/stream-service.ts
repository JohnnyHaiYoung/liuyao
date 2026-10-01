import { randomUUID } from 'node:crypto';
import { ERROR_CODES, errorMessageFor, type SseDoneData, type UsageDto } from '@/shared/types';
import { getConfig } from '../config';
import { getDb } from '../db';
import * as conversationsRepo from '../db/conversations';
import * as messagesRepo from '../db/messages';
import { formatSseComment, formatSseEvent, SSE_RESPONSE_HEADERS } from '../http/sse';
import { getDefaultProvider, resolveProviderForModel } from '../llm';
import { EMPTY_USAGE, type LlmProvider, type LlmStreamResult, type LlmUsage } from '../llm/types';
import { PROMPT_VERSION, buildSystemPrompt } from '../prompt';
import { isGenerating, registerGeneration, unregisterGeneration } from './in-flight';
import { deriveAutoTitle } from './title';

/**
 * 一次问答的流式编排。
 *
 * 时序（对应任务书 4.2）：
 *   1. 校验身份/输入/归属/并发；
 *   2. 短事务内保存用户消息与助手占位（streaming），随后释放事务；
 *   3. 调模型，边收增量边推给浏览器，并按间隔把已生成文本写入数据库；
 *   4. 结束时保存最终文本、状态、模型与用量，再发送 done；
 *   5. 失败/中断保存已生成部分；进程异常由启动恢复标为 interrupted。
 */

const KEEPALIVE_INTERVAL_MS = 15000;

export interface StartChatParams {
  ownerId: string;
  conversationId: string;
  clientMessageId: string;
  content: string;
  requestedModel?: string | null;
  /** 浏览器断开（用户点停止或网络中断）时由 Next 触发。 */
  clientSignal: AbortSignal;
}

export type StartChatOutcome =
  | { ok: true; response: Response }
  | {
      ok: false;
      status: number;
      code: string;
      message?: string;
      details?: Record<string, unknown>;
    };

export function startChatStream(params: StartChatParams): StartChatOutcome {
  const config = getConfig();
  const db = getDb();

  const provider: LlmProvider | null = params.requestedModel
    ? resolveProviderForModel(params.requestedModel)
    : getDefaultProvider();
  if (!provider) {
    return {
      ok: false,
      status: 400,
      code: ERROR_CODES.invalidRequest,
      message: `阶段 1 只支持已接入的模型：${getDefaultProvider().listModels().join(', ')}`,
    };
  }
  const model = params.requestedModel ?? provider.defaultModel;

  // 缺少密钥时在写入任何消息之前就返回明确错误，不产生“半个会话”。
  if (!provider.isConfigured()) {
    return {
      ok: false,
      status: 503,
      code: ERROR_CODES.llmNotConfigured,
      message: errorMessageFor(ERROR_CODES.llmNotConfigured),
      details: { provider: provider.id, model },
    };
  }

  const conversation = conversationsRepo.findConversationById(db, params.conversationId, params.ownerId);
  if (!conversation) {
    return { ok: false, status: 404, code: ERROR_CODES.notFound };
  }

  // 去重：同一个 clientMessageId 不插入第二条用户消息。
  const duplicate = messagesRepo.findMessageByClientId(db, params.conversationId, params.clientMessageId);
  if (duplicate) {
    return {
      ok: false,
      status: 409,
      code: ERROR_CODES.duplicateMessage,
      message: errorMessageFor(ERROR_CODES.duplicateMessage),
      details: { messageId: duplicate.id, conversationId: params.conversationId },
    };
  }

  // 同一会话只允许一个进行中的生成。
  if (isGenerating(params.conversationId)) {
    return { ok: false, status: 409, code: ERROR_CODES.generationInProgress };
  }
  const stale = messagesRepo.interruptStreamingMessages(
    db,
    params.conversationId,
    ERROR_CODES.serverRestart,
    new Date().toISOString(),
  );
  if (stale > 0) {
    console.warn(`[liuyao] 会话 ${params.conversationId} 有 ${stale} 条遗留 streaming 消息，已标记为 interrupted。`);
  }

  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let autoTitleValue: string | null = null;

  try {
    const saveMessages = db.transaction(() => {
      messagesRepo.insertUserMessage(db, {
        id: userMessageId,
        conversationId: params.conversationId,
        ownerId: params.ownerId,
        clientMessageId: params.clientMessageId,
        content: params.content,
        now: startedAt,
      });
      messagesRepo.insertAssistantPlaceholder(db, {
        id: assistantMessageId,
        conversationId: params.conversationId,
        ownerId: params.ownerId,
        provider: provider.id,
        model,
        promptVersion: PROMPT_VERSION,
        now: startedAt,
      });
      conversationsRepo.touchConversation(db, params.conversationId, startedAt);
      if (conversation.title_source === 'auto' && conversation.title.trim() === '') {
        autoTitleValue = conversationsRepo.setAutoTitleIfEmpty(
          db,
          params.conversationId,
          deriveAutoTitle(params.content),
        );
      }
    });
    saveMessages();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        ok: false,
        status: 409,
        code: ERROR_CODES.duplicateMessage,
        message: errorMessageFor(ERROR_CODES.duplicateMessage),
      };
    }
    console.error('[liuyao] 保存用户消息失败', error);
    return { ok: false, status: 500, code: ERROR_CODES.internalError };
  }

  // 上下文只取最近若干条 + 字符预算；不把整段长期历史送给模型。
  const autoTitle: string | null = autoTitleValue;
  const history = messagesRepo.buildModelContext(db, params.conversationId, {
    messageLimit: config.chat.contextMessageLimit,
    charBudget: config.chat.contextCharBudget,
  });
  const llmMessages = [{ role: 'system' as const, content: buildSystemPrompt() }, ...history];

  const upstreamController = new AbortController();
  const registered = registerGeneration({
    conversationId: params.conversationId,
    assistantMessageId,
    startedAt: startedAtMs,
    abort: () => upstreamController.abort(),
  });
  if (!registered) {
    // 极小概率竞态：登记失败则回滚占位消息状态，避免长期 streaming。
    messagesRepo.interruptStreamingMessages(
      db,
      params.conversationId,
      ERROR_CODES.generationInProgress,
      new Date().toISOString(),
    );
    return { ok: false, status: 409, code: ERROR_CODES.generationInProgress };
  }

  let assistantText = '';
  let usage: LlmUsage = { ...EMPTY_USAGE };
  let clientGone = false;
  let closed = false;
  let lastPersistAt = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          clientGone = true;
          upstreamController.abort();
        }
      };
      const send = (event: Parameters<typeof formatSseEvent>[0], data: unknown): void => {
        write(formatSseEvent(event, data));
      };
      const keepalive = setInterval(() => write(formatSseComment('keepalive')), KEEPALIVE_INTERVAL_MS);
      const onClientAbort = (): void => {
        clientGone = true;
        upstreamController.abort();
      };
      if (params.clientSignal.aborted) {
        onClientAbort();
      } else {
        params.clientSignal.addEventListener('abort', onClientAbort, { once: true });
      }

      const persistPartial = (force: boolean): void => {
        const now = Date.now();
        if (!force && now - lastPersistAt < config.chat.streamPersistIntervalMs) return;
        lastPersistAt = now;
        try {
          messagesRepo.updateAssistantPartial(db, assistantMessageId, assistantText, new Date(now).toISOString());
        } catch (error) {
          console.error('[liuyao] 保存流式增量失败', error);
        }
      };

      let result: LlmStreamResult;
      try {
        send('start', {
          conversationId: params.conversationId,
          userMessageId,
          assistantMessageId,
          provider: provider.id,
          model,
          promptVersion: PROMPT_VERSION,
          ...(autoTitle ? { conversationTitle: autoTitle } : {}),
        });

        result = await provider.streamChat(
          {
            model,
            messages: llmMessages,
            signal: upstreamController.signal,
            maxOutputTokens: config.llm.maxOutputTokens,
          },
          {
            onDelta: (text) => {
              assistantText += text;
              send('delta', { text });
              persistPartial(false);
            },
            onUsage: (next) => {
              usage = next;
            },
          },
        );
      } catch (error) {
        console.error('[liuyao] 模型流异常', error);
        result = {
          status: 'failed',
          usedModel: model,
          usage,
          errorCode: ERROR_CODES.internalError,
          errorDetail: error instanceof Error ? error.message : String(error),
        };
      }

      clearInterval(keepalive);
      params.clientSignal.removeEventListener('abort', onClientAbort);
      unregisterGeneration(params.conversationId, assistantMessageId);

      const finishedAt = new Date().toISOString();
      const latencyMs = Date.now() - startedAtMs;
      const errorCode =
        result.status === 'completed'
          ? (result.errorCode ?? null)
          : (result.errorCode ?? ERROR_CODES.upstreamError);
      const usageDto: UsageDto = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      };

      try {
        messagesRepo.finalizeAssistantMessage(db, {
          messageId: assistantMessageId,
          content: assistantText,
          status: result.status,
          usage: usageDto,
          errorCode,
          latencyMs,
          model: result.usedModel || model,
          provider: provider.id,
          now: finishedAt,
        });
        conversationsRepo.touchConversation(db, params.conversationId, finishedAt);
      } catch (error) {
        console.error('[liuyao] 保存助手消息最终状态失败', error);
      }

      if (result.status === 'completed') {
        const done: SseDoneData = {
          assistantMessageId,
          status: 'completed',
          usage: usageDto,
          ...(errorCode ? { errorCode } : {}),
        };
        send('done', done);
      } else if (result.status === 'interrupted') {
        if (!clientGone) {
          send('done', {
            assistantMessageId,
            status: 'interrupted',
            usage: usageDto,
            errorCode: errorCode ?? ERROR_CODES.clientAborted,
          } satisfies SseDoneData);
        }
      } else {
        send('error', {
          code: errorCode ?? ERROR_CODES.upstreamError,
          message: errorMessageFor(errorCode ?? ERROR_CODES.upstreamError),
          assistantMessageId,
          status: 'failed',
        });
      }

      if (result.errorDetail) {
        console.warn(
          `[liuyao] 生成结束 status=${result.status} model=${result.usedModel} code=${errorCode ?? '-'} detail=${result.errorDetail}`,
        );
      }

      closed = true;
      try {
        controller.close();
      } catch {
        /* 客户端已断开 */
      }
    },
    cancel() {
      clientGone = true;
      upstreamController.abort();
    },
  });

  return {
    ok: true,
    response: new Response(stream, { status: 200, headers: SSE_RESPONSE_HEADERS }),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  );
}
