import { randomUUID } from 'node:crypto';
import { ERROR_CODES, errorMessageFor, type SseDoneData, type UsageDto } from '@/shared/types';
import { getConfig } from '../config';
import { getDb } from '../db';
import * as conversationsRepo from '../db/conversations';
import * as messagesRepo from '../db/messages';
import { formatSseComment, formatSseEvent, SSE_RESPONSE_HEADERS } from '../http/sse';
import { getDefaultProvider, resolveProviderForModel } from '../llm';
import { EMPTY_USAGE, type LlmProvider, type LlmStreamResult, type LlmUsage } from '../llm/types';
import { PHASE4_PROMPT_VERSION } from '../prompt';
import { isGenerating, registerGeneration, unregisterGeneration } from './in-flight';
import { deriveAutoTitle } from './title';
import { loadCatalog, resolveProjectRoot, type WikiCatalog } from '../wiki/catalog';
import { buildTurnContext, type TurnContext } from './context';
import { buildSourceHref, validateCitations } from './citations';
import { buildAppendedClarification, buildMissingInputReply, planTurn, type PlanObject } from './planner';
import * as chartSnapshots from '../chart/snapshots';
import { summarizeChart, summarizeStoredChart } from '../chart/summary';
import type { ChartInput } from '../chart/service';
import { PHASE4_SYSTEM_PROMPT } from '../prompt';
import type { ChatChartInput, SseChartData, SseSourceRefData } from '@/shared/types';

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
  /** 可选的结构化排盘输入（非强制）；服务端会重新校验，前端不能决定盘面。 */
  chartInput?: ChatChartInput | null;
  /** 'new' 表示用户明确要求另起一卦。 */
  chartAction?: 'auto' | 'new' | null;
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
        promptVersion: PHASE4_PROMPT_VERSION,
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

  // ── 阶段 4：服务端编排（目录选页 + 排盘 + 预算），模型只负责解释 ──
  const projectRoot = resolveProjectRoot();
  let catalog: WikiCatalog | null = null;
  try {
    catalog = loadCatalog(projectRoot);
  } catch (error) {
    console.warn('[liuyao] Wiki 目录不可用，本次回答不提供本地证据', error);
  }

  const currentChartRun = chartSnapshots.getCurrentChartRun(db, params.conversationId);
  // 复验 P1-1：引用追问（这次/刚才/上一条引用了什么）读上一答持久化引用快照，不重新选页推断历史引用
  const CITATION_FOLLOWUP_RE = /这次(?:引用了|用了|参考了)|刚才(?:那条|这条)?(?:回答)?(?:引用了|用了|参考了)|上一条(?:引用了|用了)|本次(?:引用了|用了)/;
  const previousCitations = CITATION_FOLLOWUP_RE.test(params.content)
    ? (() => {
        const prev = db
          .prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' AND status = 'completed' ORDER BY rowid DESC LIMIT 1")
          .get(params.conversationId) as { id: string } | undefined;
        if (!prev) return [];
        return chartSnapshots.listMessageSources(db, prev.id).map((source) => ({
          sid: source.sid,
          sourceId: source.sourceId,
          locatorValue: source.locatorValue,
          qualityStatus: source.qualityStatus,
        }));
      })()
    : null;
  const planned = catalog
    ? planTurn({
        question: params.content,
        projectRoot,
        catalog,
        chartInput: (params.chartInput ?? null) as ChartInput | null,
        currentChartRunId: currentChartRun?.id ?? null,
        explicitNewChart: params.chartAction === 'new',
        promptVersion: PHASE4_PROMPT_VERSION,
        previousCitations,
      })
    : null;
  const plan: PlanObject | null = planned?.plan ?? null;

  // 缺项/含糊：由本地逻辑直接澄清，不调用模型（也必须落库并按事件契约呈现）
  const localReply = plan ? buildMissingInputReply(plan) : null;
  // 方案 A「保证追问」：判定没当成起卦、但句中像在要求起卦且输入不全时，在回答开头附一句缺项澄清
  const appendedHint = !localReply && plan ? buildAppendedClarification(plan) : null;

  const evidenceRefs: SseSourceRefData[] = (planned?.wiki.snippets ?? [])
    .filter((snippet) => snippet.citable && snippet.sourceId !== null && snippet.locatorType !== 'none')
    .map((snippet) => ({
      sid: snippet.sid,
      sourceId: snippet.sourceId!,
      pagePath: snippet.pagePath,
      locatorType: snippet.locatorType,
      locatorValue: snippet.locatorValue,
      qualityStatus: snippet.qualityStatus,
      href: buildSourceHref(snippet.sourceId!, snippet.locatorType, snippet.locatorValue),
      label: `来源 ${snippet.sourceId} ${snippet.locatorValue ?? ''}`.trim(),
      needsQualityNotice: snippet.qualityStatus === 'needs_review',
    }));

  const followUpSnapshot =
    plan?.chartAction === 'follow_up' && currentChartRun
      ? { canonicalJson: currentChartRun.chartJson, canonicalHash: currentChartRun.canonicalHash, createdAt: currentChartRun.createdAt }
      : null;

  const turnContext: TurnContext | null = planned
    ? buildTurnContext({
        question: params.content,
        wiki: planned.wiki,
        chart: planned.chart && planned.chart.ok ? planned.chart : null,
        followUpChart: followUpSnapshot,
        notes: plan?.reasons ?? [],
      })
    : null;

  // 新盘在建流之前落库（短事务，模型调用期间不持有事务）；沿用旧盘只读，不重算
  let chartRunId: string | null = plan?.chartAction === 'follow_up' ? (currentChartRun?.id ?? null) : null;
  if (planned?.chart && planned.chart.ok && plan?.chartAction === 'new') {
    try {
      chartRunId = chartSnapshots.insertChartRun(db, {
        conversationId: params.conversationId,
        createdByMessageId: assistantMessageId,
        sourceInput: params.content,
        result: planned.chart,
      });
    } catch (error) {
      console.error('[liuyao] 保存盘面快照失败', error);
      chartRunId = null;
    }
  }

  // 盘面事件：新盘用服务端刚算出的结果；沿用旧盘则**从快照还原摘要**（不重算）
  const chartEvent: SseChartData | null = (() => {
    if (plan?.chartAction === 'follow_up' && currentChartRun) {
      const restored = summarizeStoredChart(currentChartRun.chartJson, {
        chartRunId: currentChartRun.id,
        canonicalHash: currentChartRun.canonicalHash,
        ruleProfileVersion: currentChartRun.ruleProfileVersion,
        coreVersion: currentChartRun.coreVersion,
        action: 'follow_up',
      });
      return restored;
    }
    if (chartRunId && planned?.chart && planned.chart.ok) {
      return {
        action: 'new',
        chartRunId,
        canonicalHash: planned.chart.canonicalHash,
        ruleProfileVersion: planned.chart.ruleProfileVersion,
        coreVersion: planned.chart.coreVersion,
        summary: summarizeChart(planned.chart.chart as unknown as Parameters<typeof summarizeChart>[0]),
      };
    }
    return null;
  })();

  const systemContent = turnContext?.systemPrompt ?? PHASE4_SYSTEM_PROMPT;
  const llmMessages = [{ role: 'system' as const, content: systemContent }, ...history];

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
          promptVersion: PHASE4_PROMPT_VERSION,
          ...(autoTitle ? { conversationTitle: autoTitle } : {}),
        });

        if (localReply !== null) {
          // 缺项澄清由本地逻辑完成：不调用模型，因此也**不发候选资料/盘面事件**
          // （没有上游调用就没有引用，候选只会造成"这是本次依据"的误解）。
          // 事件序列为 start → delta → done。
          assistantText = localReply;
          send('delta', { text: localReply });
          persistPartial(true);
          result = {
            status: 'completed',
            usedModel: 'local-clarification',
            usage: { ...EMPTY_USAGE },
            errorCode: null,
            errorDetail: null,
            finishReason: 'local_clarification',
          };
        } else {
          // 事件顺序固定：start → sources(候选) → chart → delta* → done
          // 这里是**候选资料**（模型还没输出），带 candidate=true；
          // 只有 done.sourceIds 过滤后的编号才是最终引用（复验报告 c649c00 P1-2）。
          if (evidenceRefs.length > 0) {
            send('sources', { sources: evidenceRefs, candidate: true });
          }
          if (chartEvent) {
            send('chart', chartEvent);
          }
          if (appendedHint !== null) {
            // 作为**首个**增量发出：客户端与历史一致，且回答末尾的「最终结果：」段落仍由模型给出（格式不变）
            assistantText = `${appendedHint}\n\n`;
            send('delta', { text: assistantText });
          }
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
        }
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

      // ── 阶段 4：短事务写入来源快照、盘面绑定与计划对象（不在模型流期间持有事务） ──
      const citationResult = validateCitations(
        assistantText,
        (planned?.wiki.snippets ?? []).map((snippet) => ({
          sid: snippet.sid,
          sourceId: snippet.sourceId,
          pagePath: snippet.pagePath,
          locatorType: snippet.locatorType,
          locatorValue: snippet.locatorValue,
          qualityStatus: snippet.qualityStatus,
          citable: snippet.citable,
        })),
      );
      let savedSourceCount = 0;
      try {
        if (citationResult.citations.length > 0) {
          savedSourceCount = chartSnapshots.insertMessageSources(
            db,
            assistantMessageId,
            citationResult.citations.map((item) => ({
              sid: item.sid,
              sourceId: item.sourceId,
              pagePath: item.pagePath,
              locatorType: item.locatorType,
              locatorValue: item.locatorValue,
              qualityStatus: item.qualityStatus,
              excerpt: (planned?.wiki.snippets.find((snippet) => snippet.sid === item.sid)?.excerpt ?? '').slice(0, 4000),
              pageSha256: planned?.wiki.snippets.find((snippet) => snippet.sid === item.sid)?.pageSha256 ?? '',
            })),
          );
        }
        chartSnapshots.bindMessageChart(db, {
          messageId: assistantMessageId,
          chartRunId,
          planJson: plan ? JSON.stringify(plan) : null,
          promptVersion: PHASE4_PROMPT_VERSION,
        });
        if (chartRunId && plan?.chartAction === 'new') {
          chartSnapshots.setCurrentChartRun(db, params.conversationId, chartRunId);
        }
      } catch (error) {
        console.error('[liuyao] 保存来源/盘面快照失败', error);
      }
      const sourceIds = citationResult.citations.map((item) => item.sid);
      if (citationResult.unmappedSids.length > 0) {
        console.warn(`[liuyao] 助手消息 ${assistantMessageId} 引用了未映射编号：${citationResult.unmappedSids.join(',')}`);
      }

      if (result.status === 'completed') {
        const done: SseDoneData = {
          assistantMessageId,
          status: 'completed',
          usage: usageDto,
          ...(errorCode ? { errorCode } : {}),
          sourceIds,
          chartRunId,
        };
        send('done', done);
      } else if (result.status === 'interrupted') {
        if (!clientGone) {
          send('done', {
            assistantMessageId,
            status: 'interrupted',
            usage: usageDto,
            errorCode: errorCode ?? ERROR_CODES.clientAborted,
            sourceIds,
            chartRunId,
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
      if (savedSourceCount > 0) {
        console.info(`[liuyao] 已保存 ${savedSourceCount} 条来源快照（消息 ${assistantMessageId}）`);
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
