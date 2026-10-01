/**
 * 前后端共享的类型定义（第一阶段）。
 *
 * 前端组件与服务端路由都从这里导入，避免两端各自定义不兼容的消息结构。
 * 本文件不得导入任何 Node 专有模块，否则会被打进浏览器包。
 */

/** 第一阶段只接入 DeepSeek Flash；千问在阶段 4 接通后加入。 */
export const AVAILABLE_MODELS = [
  {
    id: 'deepseek-flash',
    provider: 'deepseek',
    label: 'DeepSeek Flash',
    available: true,
  },
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number]['id'];

export const DEFAULT_MODEL: ModelId = 'deepseek-flash';

export type MessageRole = 'user' | 'assistant' | 'system';

/** 助手消息的生成状态；用户消息保存后固定为 completed。 */
export type MessageStatus = 'streaming' | 'completed' | 'interrupted' | 'failed';

export type TitleSource = 'auto' | 'manual';

export interface OwnerInfo {
  id: string;
  username: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** 可选的补充信息，例如冲突时的消息 ID、限流的等待秒数。 */
    details?: Record<string, unknown>;
  };
}

export interface UsageDto {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  titleSource: TitleSource;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  /** 最近一条消息的状态，用于列表上显示“中断/失败”标记。 */
  lastMessageStatus: MessageStatus | null;
  lastModel: string | null;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  usage: UsageDto | null;
}

export interface ConversationListResponse {
  items: ConversationSummary[];
  nextCursor: string | null;
}

export interface MessageListResponse {
  items: MessageDto[];
  /** 更早消息的游标；为空表示已到最早。 */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ConversationDetailResponse {
  conversation: ConversationSummary;
}

export interface CreateConversationRequest {
  /** 浏览器生成的草稿 ID；重试同一草稿不会创建重复会话。 */
  clientConversationId: string;
}

export interface CreateConversationResponse {
  id: string;
  title: string;
  titleSource: TitleSource;
  createdAt: string;
  updatedAt: string;
  /** true 表示本次新建，false 表示按 clientConversationId 命中的既有会话。 */
  created: boolean;
}

export interface RenameConversationRequest {
  title: string;
}

export interface DeleteConversationResponse {
  deleted: true;
  id: string;
  /** 随会话一并删除的消息条数（便于核对级联删除）。 */
  deletedMessages: number;
}

export interface LoginRequest {
  username?: string;
  password: string;
}

export interface LoginResponse {
  owner: OwnerInfo;
  expiresAt: string;
}

export interface MeResponse {
  authenticated: true;
  owner: OwnerInfo;
}

export interface ChatRequest {
  /** 浏览器生成的消息 ID，用于服务端去重。 */
  clientMessageId: string;
  content: string;
  /** 可选模型覆盖；阶段 1 只有 deepseek-flash。 */
  model?: string;
}

export interface HealthzResponse {
  status: 'ok' | 'degraded';
  time: string;
  version: string;
  database: { ok: boolean; migrations: number };
  llm: { configured: boolean; provider: string; model: string; mode: 'live' | 'fake' };
  auth: { ownerConfigured: boolean };
  server: { trustProxy: boolean };
}

/* ------------------------------------------------------------------ */
/* SSE 事件（服务端规范化的项目自有格式，不透传上游 DeepSeek 事件）      */
/* ------------------------------------------------------------------ */

export type SseEventName = 'start' | 'delta' | 'done' | 'error';

export interface SseStartData {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  provider: string;
  model: string;
  promptVersion: string;
  /** 首条消息后服务端生成的标题；非空时前端可直接更新列表。 */
  conversationTitle?: string;
}

export interface SseDeltaData {
  text: string;
}

export interface SseDoneData {
  assistantMessageId: string;
  status: Extract<MessageStatus, 'completed' | 'interrupted' | 'failed'>;
  usage: UsageDto;
  /** 仅在 failed/interrupted 时出现。 */
  errorCode?: string;
}

export interface SseErrorData {
  code: string;
  message: string;
  assistantMessageId?: string;
  status?: Extract<MessageStatus, 'interrupted' | 'failed'>;
}

/** 服务端返回的安全错误码（不含密钥、路径或上游原文）。 */
export const ERROR_CODES = {
  authRequired: 'auth_required',
  authNotConfigured: 'auth_not_configured',
  invalidCredentials: 'invalid_credentials',
  invalidRequest: 'invalid_request',
  forbiddenOrigin: 'forbidden_origin',
  notFound: 'not_found',
  rateLimited: 'rate_limited',
  generationInProgress: 'generation_in_progress',
  duplicateMessage: 'duplicate_message',
  llmNotConfigured: 'llm_not_configured',
  upstreamAuthError: 'upstream_auth_error',
  upstreamInsufficientBalance: 'upstream_insufficient_balance',
  upstreamRateLimited: 'upstream_rate_limited',
  upstreamBadRequest: 'upstream_bad_request',
  upstreamTimeout: 'upstream_timeout',
  upstreamUnavailable: 'upstream_unavailable',
  upstreamError: 'upstream_error',
  /** 上游响应没有正常结束（缺 [DONE] 或 finish_reason）：绝不谎报为 completed。 */
  upstreamTruncated: 'upstream_truncated',
  outputLimitReached: 'output_limit_reached',
  contentFiltered: 'content_filtered',
  clientAborted: 'client_aborted',
  serverRestart: 'server_restart',
  internalError: 'internal_error',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 服务端错误码 -> 用户可读的中文说明（前端不再自行拼接文案）。 */
export const ERROR_MESSAGES: Record<string, string> = {
  [ERROR_CODES.authRequired]: '登录状态已失效，请重新登录。',
  [ERROR_CODES.authNotConfigured]: '服务器尚未配置拥有者密码，暂时无法登录。',
  [ERROR_CODES.invalidCredentials]: '密码不正确。',
  [ERROR_CODES.invalidRequest]: '请求内容不合法。',
  [ERROR_CODES.forbiddenOrigin]: '跨站请求被拒绝。',
  [ERROR_CODES.notFound]: '找不到该会话或消息。',
  [ERROR_CODES.rateLimited]: '操作过于频繁，请稍后再试。',
  [ERROR_CODES.generationInProgress]: '该会话正在生成回复，请先等待或停止当前生成。',
  [ERROR_CODES.duplicateMessage]: '这条消息已经保存过，未重复发送。',
  [ERROR_CODES.llmNotConfigured]: '服务器尚未配置 DeepSeek API Key，无法生成回复。',
  [ERROR_CODES.upstreamAuthError]: '模型服务拒绝了本次调用（API Key 无效或无权限）。',
  [ERROR_CODES.upstreamInsufficientBalance]: '模型服务账户余额不足，请充值后再试。',
  [ERROR_CODES.upstreamRateLimited]: '模型服务限流，请稍后重试。',
  [ERROR_CODES.upstreamBadRequest]: '模型服务拒绝了本次请求参数。',
  [ERROR_CODES.upstreamTimeout]: '模型服务响应超时。',
  [ERROR_CODES.upstreamUnavailable]: '模型服务暂时不可用。',
  [ERROR_CODES.upstreamError]: '模型调用失败。',
  [ERROR_CODES.upstreamTruncated]: '模型响应没有正常结束，已保存收到的部分内容，请重试或继续追问。',
  [ERROR_CODES.outputLimitReached]: '回复达到长度上限，已保存已生成部分。',
  [ERROR_CODES.contentFiltered]: '内容被模型服务的安全策略拦截。',
  [ERROR_CODES.clientAborted]: '已由用户停止生成。',
  [ERROR_CODES.serverRestart]: '服务重启，上一轮生成被标记为中断。',
  [ERROR_CODES.internalError]: '服务器内部错误。',
};

export function errorMessageFor(code: string): string {
  return ERROR_MESSAGES[code] ?? '发生未知错误。';
}
