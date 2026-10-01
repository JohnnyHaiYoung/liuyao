import {
  ERROR_CODES,
  errorMessageFor,
  type ApiErrorBody,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type CreateConversationResponse,
  type LoginResponse,
  type MeResponse,
  type MessageListResponse,
  type SseDeltaData,
  type SseDoneData,
  type SseErrorData,
  type SseStartData,
} from '@/shared/types';

/**
 * 浏览器侧接口封装。
 * - 普通接口用 JSON。
 * - 聊天接口用 fetch() 读取 text/event-stream（POST 需要请求体，所以不用 EventSource）。
 */

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message?: string, details?: Record<string, unknown>) {
    super(message ?? errorMessageFor(code));
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function readErrorBody(response: Response): Promise<ApiErrorBody | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as ApiErrorBody;
  } catch {
    return null;
  }
}

function toRequestError(status: number, body: ApiErrorBody | null): ApiRequestError {
  const code = body?.error?.code ?? ERROR_CODES.internalError;
  return new ApiRequestError(status, code, body?.error?.message, body?.error?.details);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw toRequestError(response.status, await readErrorBody(response));
  }
  return (await response.json()) as T;
}

export const api = {
  me(): Promise<MeResponse> {
    return requestJson<MeResponse>('/api/auth/me');
  },
  login(password: string): Promise<LoginResponse> {
    return requestJson<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },
  logout(): Promise<{ loggedOut: boolean }> {
    return requestJson<{ loggedOut: boolean }>('/api/auth/logout', { method: 'POST' });
  },
  listConversations(options?: { limit?: number; cursor?: string | null }): Promise<ConversationListResponse> {
    const params = new URLSearchParams();
    params.set('limit', String(options?.limit ?? 30));
    if (options?.cursor) params.set('cursor', options.cursor);
    return requestJson<ConversationListResponse>(`/api/conversations?${params.toString()}`);
  },
  createConversation(clientConversationId: string): Promise<CreateConversationResponse> {
    return requestJson<CreateConversationResponse>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ clientConversationId }),
    });
  },
  getConversation(id: string): Promise<ConversationDetailResponse> {
    return requestJson<ConversationDetailResponse>(`/api/conversations/${encodeURIComponent(id)}`);
  },
  listMessages(id: string, options?: { limit?: number; before?: string | null }): Promise<MessageListResponse> {
    const params = new URLSearchParams();
    params.set('limit', String(options?.limit ?? 50));
    if (options?.before) params.set('before', options.before);
    return requestJson<MessageListResponse>(
      `/api/conversations/${encodeURIComponent(id)}/messages?${params.toString()}`,
    );
  },
  renameConversation(id: string, title: string): Promise<ConversationDetailResponse> {
    return requestJson<ConversationDetailResponse>(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  },
};

/* ------------------------------------------------------------------ */
/* SSE 解析                                                            */
/* ------------------------------------------------------------------ */

interface SseFrame {
  event: string;
  data: string;
}

/**
 * 增量解析 SSE。TextDecoder({stream:true}) 负责跨分块的多字节字符，
 * 这里只按空行切帧，因此 UTF-8 字符被网络分块切开也不会乱码。
 */
export function createSseParser(onFrame: (frame: SseFrame) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';
  const boundary = /\r?\n\r?\n/;

  const handleRaw = (raw: string): void => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line === '' || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length === 0) return;
    onFrame({ event, data: dataLines.join('\n') });
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      let match = boundary.exec(buffer);
      while (match) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        handleRaw(raw);
        match = boundary.exec(buffer);
      }
    },
    flush(): void {
      if (buffer.trim() !== '') {
        handleRaw(buffer);
      }
      buffer = '';
    },
  };
}

export interface ChatStreamHandlers {
  onStart?: (data: SseStartData) => void;
  onDelta?: (data: SseDeltaData) => void;
  onDone?: (data: SseDoneData) => void;
  onError?: (data: SseErrorData) => void;
}

export interface ChatStreamParams {
  conversationId: string;
  clientMessageId: string;
  content: string;
  model?: string;
  signal: AbortSignal;
}

/**
 * 发送问题并消费服务端规范化的 SSE。
 * 非 2xx 响应（未登录、缺密钥、并发冲突、重复消息等）抛 ApiRequestError：
 * 此时流尚未开始，调用方可以安全地把用户输入退回输入框。
 */
export async function streamChat(params: ChatStreamParams, handlers: ChatStreamHandlers): Promise<void> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(params.conversationId)}/messages`,
    {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        clientMessageId: params.clientMessageId,
        content: params.content,
        ...(params.model ? { model: params.model } : {}),
      }),
      signal: params.signal,
    },
  );

  if (!response.ok) {
    throw toRequestError(response.status, await readErrorBody(response));
  }
  if (!response.body) {
    throw new ApiRequestError(500, ERROR_CODES.internalError, '服务端没有返回流式响应体。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = createSseParser(({ event, data }) => {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    switch (event) {
      case 'start':
        handlers.onStart?.(payload as SseStartData);
        break;
      case 'delta':
        handlers.onDelta?.(payload as SseDeltaData);
        break;
      case 'done':
        handlers.onDone?.(payload as SseDoneData);
        break;
      case 'error':
        handlers.onError?.(payload as SseErrorData);
        break;
      default:
        break;
    }
  });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.flush();
}

export function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
