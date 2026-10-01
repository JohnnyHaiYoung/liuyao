'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  ERROR_CODES,
  errorMessageFor,
  type ConversationSummary,
  type MessageDto,
  type OwnerInfo,
} from '@/shared/types';
import { ApiRequestError, api, newClientId, streamChat } from '@/lib/api-client';
import { MarkdownContent } from './MarkdownContent';

/**
 * 聊天主界面（客户端组件）。
 *
 * 说明：
 * - 会话列表、消息、重命名都走后端 JSON 接口；
 * - 发送问题时用 fetch() 读取 SSE，逐段显示文字；
 * - 生成过程中禁止切换会话，避免同一会话出现两条并发请求；
 * - 生成结束后一律以服务端历史为准刷新，保证状态（completed/failed/interrupted）一致。
 */

interface ChatAppProps {
  owner: OwnerInfo;
  llmConfigured: boolean;
  defaultModel: string;
  /** true 表示服务器启用了 LIUYAO_FAKE_MODEL=1（本地验收假模型）。 */
  fakeMode?: boolean;
}

type Banner = { kind: 'error' | 'info'; text: string } | null;

const MESSAGE_PAGE_SIZE = 50;
const CONVERSATION_PAGE_SIZE = 30;

/** 按 id 去重并按更新时间倒序合并会话列表（刷新与分页加载共用）。 */
function mergeConversations(
  previous: ConversationSummary[],
  incoming: ConversationSummary[],
): ConversationSummary[] {
  const byId = new Map<string, ConversationSummary>();
  for (const item of previous) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return a.id < b.id ? 1 : -1;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusLabel(status: MessageDto['status']): { text: string; className: string } | null {
  switch (status) {
    case 'streaming':
      return { text: '正在生成', className: 'badge muted' };
    case 'interrupted':
      return { text: '已停止', className: 'badge warn' };
    case 'failed':
      return { text: '生成失败', className: 'badge danger' };
    default:
      return null;
  }
}

function conversationBadge(status: ConversationSummary['lastMessageStatus']): { text: string; className: string } | null {
  switch (status) {
    case 'streaming':
      return { text: '生成中', className: 'badge muted' };
    case 'interrupted':
      return { text: '已中断', className: 'badge warn' };
    case 'failed':
      return { text: '失败', className: 'badge danger' };
    default:
      return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ChatApp({ owner, llmConfigured, defaultModel, fakeMode = false }: ChatAppProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string>(() => newClientId());
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [generating, setGenerating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [banner, setBanner] = useState<Banner>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  /** 主区标题的就地重命名（与左侧列表重命名同一会话属性）。 */
  const [headerRenameValue, setHeaderRenameValue] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeIdRef = useRef<string | null>(null);

  activeIdRef.current = activeId;

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeId) ?? null,
    [conversations, activeId],
  );

  const handleFailure = useCallback((error: unknown): void => {
    if (error instanceof ApiRequestError) {
      if (error.status === 401) {
        window.location.assign('/login');
        return;
      }
      setBanner({ kind: 'error', text: error.message });
      return;
    }
    setBanner({ kind: 'error', text: '发生未知错误，请重试。' });
  }, []);

  /**
   * 刷新会话列表第一页，并与已加载的旧页合并（按 id 去重、按更新时间排序）。
   * 保留既有 cursor，使“加载更早的会话”可以从上次的位置继续。
   */
  const refreshConversations = useCallback(async (): Promise<ConversationSummary[]> => {
    const page = await api.listConversations({ limit: CONVERSATION_PAGE_SIZE });
    const merged = mergeConversations([], page.items);
    setConversations((prev) => mergeConversations(prev, merged));
    setConversationCursor((prev) => prev ?? page.nextCursor);
    return page.items;
  }, []);

  /** 加载更早的会话（第 51 条及以前）。 */
  const loadMoreConversations = useCallback(async (): Promise<void> => {
    if (!conversationCursor || loadingMoreConversations) return;
    setLoadingMoreConversations(true);
    try {
      const page = await api.listConversations({
        limit: CONVERSATION_PAGE_SIZE,
        cursor: conversationCursor,
      });
      setConversations((prev) => mergeConversations(prev, page.items));
      setConversationCursor(page.nextCursor);
    } catch (error) {
      handleFailure(error);
    } finally {
      setLoadingMoreConversations(false);
    }
  }, [conversationCursor, handleFailure, loadingMoreConversations]);

  const loadMessages = useCallback(
    async (conversationId: string, options?: { before?: string | null; append?: boolean }): Promise<MessageDto[]> => {
      setLoadingMessages(true);
      try {
        const page = await api.listMessages(conversationId, {
          limit: MESSAGE_PAGE_SIZE,
          before: options?.before ?? null,
        });
        setMessages((prev) => (options?.append ? [...page.items, ...prev] : page.items));
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
        return page.items;
      } finally {
        setLoadingMessages(false);
      }
    },
    [],
  );

  /** 生成结束后等服务器把状态写定，再以服务端历史刷新。 */
  const refreshAfterGeneration = useCallback(
    async (conversationId: string): Promise<void> => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const items = await loadMessages(conversationId);
          if (!items.some((item) => item.status === 'streaming')) return;
        } catch (error) {
          handleFailure(error);
          return;
        }
        await delay(400);
      }
    },
    [handleFailure, loadMessages],
  );

  // 首次进入：拉取历史列表，并自动打开最近一次会话（没有历史则进入空白草稿）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await refreshConversations();
        if (cancelled) return;
        const first = items[0];
        if (first) {
          setActiveId(first.id);
          await loadMessages(first.id);
        }
      } catch (error) {
        if (!cancelled) handleFailure(error);
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleFailure, loadMessages, refreshConversations]);

  // 新消息或增量到达时滚到底部。
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamText, generating]);

  const openConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      if (generating) {
        setBanner({ kind: 'info', text: '正在生成回复，请先停止或等待完成再切换会话。' });
        return;
      }
      setBanner(null);
      setActiveId(conversationId);
      setStreamText('');
      setHistoryOpen(false);
      try {
        await loadMessages(conversationId);
      } catch (error) {
        handleFailure(error);
      }
    },
    [generating, handleFailure, loadMessages],
  );

  const startNewChat = useCallback((): void => {
    if (generating) {
      setBanner({ kind: 'info', text: '正在生成回复，请先停止或等待完成再新建会话。' });
      return;
    }
    setBanner(null);
    setActiveId(null);
    setMessages([]);
    setHasMore(false);
    setNextCursor(null);
    setStreamText('');
    setDraftId(newClientId());
    setHistoryOpen(false);
    textareaRef.current?.focus();
  }, [generating]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (!activeId || !nextCursor || loadingMessages) return;
    try {
      await loadMessages(activeId, { before: nextCursor, append: true });
    } catch (error) {
      handleFailure(error);
    }
  }, [activeId, handleFailure, loadMessages, loadingMessages, nextCursor]);

  const handleSend = useCallback(async (): Promise<void> => {
    const content = composer.trim();
    if (content === '' || generating) return;

    setBanner(null);
    const clientMessageId = newClientId();
    const localUserId = `local-user-${clientMessageId}`;
    const now = new Date().toISOString();

    let conversationId = activeId;
    if (!conversationId) {
      try {
        const created = await api.createConversation(draftId);
        conversationId = created.id;
        setActiveId(created.id);
        setDraftId(newClientId());
      } catch (error) {
        handleFailure(error);
        return;
      }
    }

    const optimisticUser: MessageDto = {
      id: localUserId,
      conversationId,
      role: 'user',
      content,
      status: 'completed',
      provider: null,
      model: null,
      promptVersion: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      usage: null,
    };

    setMessages((prev) => [...prev, optimisticUser]);
    setComposer('');
    setStreamText('');
    setGenerating(true);
    setStopping(false);

    const controller = new AbortController();
    abortRef.current = controller;
    let startedStream = false;

    try {
      await streamChat(
        { conversationId, clientMessageId, content, model: defaultModel, signal: controller.signal },
        {
          onStart: (data) => {
            startedStream = true;
            setMessages((prev) =>
              prev.map((item) => (item.id === localUserId ? { ...item, id: data.userMessageId } : item)),
            );
            if (data.conversationTitle) {
              setConversations((prev) =>
                prev.map((item) =>
                  item.id === data.conversationId ? { ...item, title: data.conversationTitle! } : item,
                ),
              );
            }
          },
          onDelta: (data) => {
            setStreamText((prev) => prev + data.text);
          },
          onDone: () => {
            /* 状态以服务端为准，下面统一刷新。 */
          },
          onError: (data) => {
            setBanner({
              kind: 'error',
              text: data.message || errorMessageFor(data.code),
            });
          },
        },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        setBanner({ kind: 'info', text: '已停止生成，已保存已收到的部分内容。' });
      } else if (error instanceof ApiRequestError) {
        if (!startedStream) {
          // 流尚未开始（未登录、缺密钥、限流、重复消息…）：本次没有保存用户消息，
          // 把文字退回输入框，并移除乐观显示，避免出现重复用户消息。
          setMessages((prev) => prev.filter((item) => item.id !== localUserId));
          if (error.code !== ERROR_CODES.duplicateMessage && error.code !== ERROR_CODES.generationInProgress) {
            setComposer((prev) => (prev === '' ? content : prev));
          }
        }
        handleFailure(error);
        if (error.code === ERROR_CODES.duplicateMessage) {
          setBanner({ kind: 'info', text: '这条消息之前已经发送过，已加载服务端记录。' });
        }
      } else {
        handleFailure(error);
      }
    } finally {
      abortRef.current = null;
      setGenerating(false);
      setStopping(false);
      setStreamText('');
      if (conversationId) {
        await refreshAfterGeneration(conversationId);
      }
      try {
        await refreshConversations();
      } catch (error) {
        handleFailure(error);
      }
    }
  }, [
    activeId,
    composer,
    defaultModel,
    draftId,
    generating,
    handleFailure,
    refreshAfterGeneration,
    refreshConversations,
  ]);

  const handleStop = useCallback((): void => {
    if (!generating) return;
    setStopping(true);
    abortRef.current?.abort();
  }, [generating]);

  const handleLogout = useCallback(async (): Promise<void> => {
    try {
      await api.logout();
    } catch {
      /* 忽略：无论如何都回到登录页 */
    }
    window.location.assign('/login');
  }, []);

  const startRename = useCallback((conversation: ConversationSummary): void => {
    setRenamingId(conversation.id);
    setRenameValue(conversation.title);
  }, []);

  /** 重命名是会话属性：无论从左侧列表还是主区标题触发，都调用同一接口。 */
  const applyRename = useCallback(
    async (id: string, rawTitle: string): Promise<void> => {
      const title = rawTitle.trim();
      if (title === '') return;
      try {
        const updated = await api.renameConversation(id, title);
        setConversations((prev) => prev.map((item) => (item.id === id ? updated.conversation : item)));
        setBanner(null);
      } catch (error) {
        handleFailure(error);
      }
    },
    [handleFailure],
  );

  const commitRename = useCallback(async (): Promise<void> => {
    const id = renamingId;
    if (!id) return;
    const value = renameValue;
    setRenamingId(null);
    await applyRename(id, value);
  }, [applyRename, renameValue, renamingId]);

  const commitHeaderRename = useCallback(async (): Promise<void> => {
    const id = activeId;
    const value = headerRenameValue ?? '';
    setHeaderRenameValue(null);
    if (!id) return;
    await applyRename(id, value);
  }, [activeId, applyRename, headerRenameValue]);

  const onComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key !== 'Enter') return;
      // 中文输入法选词回车不发送。
      if (event.nativeEvent.isComposing) return;
      if (event.shiftKey) return;
      event.preventDefault();
      void handleSend();
    },
    [handleSend],
  );

  const modelLabel = useMemo(() => {
    const found = AVAILABLE_MODELS.find((item) => item.id === defaultModel);
    return found?.label ?? DEFAULT_MODEL;
  }, [defaultModel]);

  return (
    <div className="app-shell">
      {historyOpen ? (
        <button className="sidebar-scrim" aria-label="关闭历史列表" onClick={() => setHistoryOpen(false)} />
      ) : null}

      <aside className={`sidebar${historyOpen ? ' open' : ''}`}>
        <div className="sidebar-header">
          <div className="brand">
            <h1>六爻 Agent</h1>
            <span className="phase">阶段 1</span>
          </div>
          <button className="button primary" type="button" onClick={startNewChat}>
            + 新建聊天
          </button>
        </div>

        <div className="conversation-list">
          {conversations.length === 0 ? (
            <p className="conversation-meta" style={{ padding: '8px 10px' }}>
              还没有历史会话。发送第一条消息后会出现在这里。
            </p>
          ) : null}

          {conversations.map((conversation) => {
            const badge = conversationBadge(conversation.lastMessageStatus);
            const isActive = conversation.id === activeId;
            return (
              <div
                key={conversation.id}
                className={`conversation-item${isActive ? ' active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => void openConversation(conversation.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void openConversation(conversation.id);
                  }
                }}
              >
                <div className="row">
                  {renamingId === conversation.id ? (
                    <input
                      value={renameValue}
                      autoFocus
                      maxLength={80}
                      style={{ width: '100%', padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)' }}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void commitRename();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          setRenamingId(null);
                        }
                      }}
                      onBlur={() => void commitRename()}
                    />
                  ) : (
                    <>
                      <span className="conversation-title">{conversation.title || '未命名会话'}</span>
                      <button
                        type="button"
                        className="icon-button"
                        title="重命名会话标题"
                        onClick={(event) => {
                          event.stopPropagation();
                          startRename(conversation);
                        }}
                      >
                        重命名
                      </button>
                    </>
                  )}
                </div>
                <div className="conversation-meta">
                  <span>{formatTime(conversation.updatedAt)}</span>
                  {conversation.titleSource === 'manual' ? <span className="badge muted">手动标题</span> : null}
                  {badge ? <span className={badge.className}>{badge.text}</span> : null}
                </div>
              </div>
            );
          })}

          {conversationCursor ? (
            <button
              type="button"
              className="button ghost"
              style={{ margin: '6px 2px 2px' }}
              onClick={() => void loadMoreConversations()}
              disabled={loadingMoreConversations}
            >
              {loadingMoreConversations ? '加载中…' : '加载更早的会话'}
            </button>
          ) : null}
        </div>

        <div className="sidebar-footer">
          <span>已登录：{owner.username}</span>
          <button type="button" className="icon-button" onClick={() => void handleLogout()}>
            退出
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="main-header">
          <div style={{ minWidth: 0, flex: 1 }}>
            {headerRenameValue !== null ? (
              <input
                className="header-rename-input"
                value={headerRenameValue}
                autoFocus
                maxLength={80}
                aria-label="会话标题"
                onChange={(event) => setHeaderRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitHeaderRename();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setHeaderRenameValue(null);
                  }
                }}
                onBlur={() => void commitHeaderRename()}
              />
            ) : (
              <div className="title">
                <span className="title-text">
                  {activeConversation?.title || (activeId ? '未命名会话' : '新聊天')}
                </span>
                {activeId ? (
                  <button
                    type="button"
                    className="icon-button"
                    title="重命名会话标题"
                    onClick={() => setHeaderRenameValue(activeConversation?.title ?? '')}
                  >
                    重命名
                  </button>
                ) : null}
              </div>
            )}
            <div className="sub">
              <span className="badge muted">模型：{modelLabel}</span>
              {activeId ? <span>会话 ID：{activeId.slice(0, 8)}…</span> : <span>发送第一条消息时创建会话</span>}
            </div>
          </div>
          <button
            type="button"
            className="button ghost mobile-only"
            onClick={() => setHistoryOpen((prev) => !prev)}
          >
            历史
          </button>
        </header>

        <div className="messages">
          {banner ? (
            <div className={`banner ${banner.kind}`} role={banner.kind === 'error' ? 'alert' : undefined}>
              <span>{banner.text}</span>
              <button type="button" className="icon-button" onClick={() => setBanner(null)}>
                关闭
              </button>
            </div>
          ) : null}

          {fakeMode ? (
            <div className="banner error" role="alert">
              <span>
                当前服务器启用了 LIUYAO_FAKE_MODEL=1：回复由本地「验收用假模型」生成，未调用 DeepSeek 或任何模型服务。
                仅用于验证流式与持久化链路，请勿据此判断模型能力。
              </span>
            </div>
          ) : null}

          {!llmConfigured ? (
            <div className="banner error" role="alert">
              <span>
                服务器尚未配置 DEEPSEEK_API_KEY，当前无法生成回复（历史记录仍可查看）。请在服务器环境中配置密钥后重启服务。
              </span>
            </div>
          ) : null}

          {bootstrapped && messages.length === 0 && !generating ? (
            <div className="empty-state">
              <h2>可以开始自由提问</h2>
              <p>本阶段只接通 DeepSeek Flash，尚未接入项目 Wiki 资料与六爻排盘程序。</p>
              <ul>
                <li>回答不会声称已经读完书籍或已核对原文，也不会编造页码与引文。</li>
                <li>具体排盘尚不可用；系统会说明缺少的能力与所需输入，但不会编造卦盘。</li>
                <li>生成过程中可以点“停止”；完成、失败、中断状态都会保存到历史。</li>
              </ul>
            </div>
          ) : null}

          {hasMore ? (
            <div style={{ textAlign: 'center' }}>
              <button type="button" className="button ghost" onClick={() => void loadOlder()} disabled={loadingMessages}>
                {loadingMessages ? '加载中…' : '加载更早的消息'}
              </button>
            </div>
          ) : null}

          {messages.map((message) => {
            const badge = statusLabel(message.status);
            return (
              <article key={message.id} className={`message ${message.role === 'user' ? 'user' : 'assistant'}`}>
                <div className="who">
                  <span>{message.role === 'user' ? '你' : '助手'}</span>
                  <span>{formatTime(message.createdAt)}</span>
                  {message.role === 'assistant' && message.model ? (
                    <span className="badge muted">{message.model}</span>
                  ) : null}
                  {badge ? <span className={badge.className}>{badge.text}</span> : null}
                  {message.errorCode ? <span className="badge muted">{message.errorCode}</span> : null}
                  {message.usage?.outputTokens != null ? (
                    <span>输出 {message.usage.outputTokens} tokens</span>
                  ) : null}
                </div>
                <div className="bubble">
                  {message.role === 'user' ? (
                    message.content
                  ) : message.content.trim() === '' ? (
                    <span className="conversation-meta">
                      {message.status === 'failed'
                        ? `（未生成内容：${message.errorCode ? errorMessageFor(message.errorCode) : '模型调用失败'}）`
                        : message.status === 'interrupted'
                          ? '（未生成内容：已停止）'
                          : '（空）'}
                    </span>
                  ) : (
                    <MarkdownContent text={message.content} />
                  )}
                </div>
              </article>
            );
          })}

          {generating ? (
            <article className="message assistant">
              <div className="who">
                <span>助手</span>
                <span className="badge muted">{modelLabel}</span>
                <span className="badge muted">{stopping ? '正在停止…' : '正在生成'}</span>
              </div>
              <div className="bubble streaming">
                {streamText.trim() === '' ? (
                  <span className="conversation-meta">正在等待模型返回第一段内容…</span>
                ) : (
                  <>
                    <MarkdownContent text={streamText} />
                    <span className="caret" aria-hidden="true" />
                  </>
                )}
              </div>
            </article>
          ) : null}

          <div ref={messagesEndRef} />
        </div>

        <div className="composer">
          <div className="composer-inner">
            <textarea
              ref={textareaRef}
              rows={2}
              value={composer}
              placeholder="输入问题，Enter 发送，Shift+Enter 换行"
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={onComposerKeyDown}
              disabled={generating}
            />
            <div className="composer-actions">
              <span>
                {composer.trim().length > 0 ? `${Array.from(composer.trim()).length} 字` : '空白消息不会发送'}
              </span>
              {generating ? (
                <button type="button" className="button danger" onClick={handleStop} disabled={stopping}>
                  {stopping ? '停止中…' : '停止生成'}
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  onClick={() => void handleSend()}
                  disabled={composer.trim() === ''}
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
