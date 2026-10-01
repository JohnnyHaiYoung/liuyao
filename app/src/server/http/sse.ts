import type { SseEventName } from '@/shared/types';

/**
 * 服务端 → 浏览器的 SSE 编码。
 * 事件名与数据格式是本项目自己的契约（见 docs/phase1_delivery.md），
 * 上游 DeepSeek 的事件不会原样透传。
 */

export function formatSseEvent(event: SseEventName, data: unknown): string {
  // data 一定单行，避免换行破坏 SSE 帧结构。
  const payload = JSON.stringify(data).replace(/\r?\n/g, '\\n');
  return `event: ${event}\ndata: ${payload}\n\n`;
}

/** SSE 注释，用作保活（思考模式下首段正文可能较慢）。 */
export function formatSseComment(text: string): string {
  return `: ${text.replace(/\r?\n/g, ' ')}\n\n`;
}

export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform 阻止中间层压缩/重写，X-Accel-Buffering 关闭 nginx 缓冲。
  'Cache-Control': 'no-cache, no-store, no-transform',
  'X-Accel-Buffering': 'no',
  Connection: 'keep-alive',
};
