/**
 * 会话标题规则。
 *
 * 首条用户消息成功保存后，用其开头生成简短默认标题（不额外调用 LLM）。
 * 手动重命名后的标题来源为 manual，不再被自动标题覆盖。
 */

export const DEFAULT_TITLE_MAX_LENGTH = 24;
export const TITLE_MAX_LENGTH = 80;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function deriveAutoTitle(content: string, maxLength = DEFAULT_TITLE_MAX_LENGTH): string {
  const normalized = normalizeWhitespace(content);
  if (normalized === '') return '新会话';
  const chars = Array.from(normalized);
  if (chars.length <= maxLength) return normalized;
  return `${chars.slice(0, maxLength).join('')}…`;
}

export interface TitleValidation {
  ok: boolean;
  value: string;
  message?: string;
}

export function validateTitle(raw: unknown): TitleValidation {
  if (typeof raw !== 'string') {
    return { ok: false, value: '', message: '标题必须是字符串。' };
  }
  const value = normalizeWhitespace(raw);
  if (value === '') {
    return { ok: false, value: '', message: '标题不能为空。' };
  }
  if (Array.from(value).length > TITLE_MAX_LENGTH) {
    return { ok: false, value: '', message: `标题最长 ${TITLE_MAX_LENGTH} 个字符。` };
  }
  return { ok: true, value };
}
