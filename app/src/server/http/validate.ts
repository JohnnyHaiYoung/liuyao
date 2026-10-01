/** 输入校验工具：长度、字符集与分页参数。 */

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function normalizeClientId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return CLIENT_ID_PATTERN.test(value) ? value : null;
}

export interface ContentValidation {
  ok: boolean;
  value: string;
  message?: string;
}

export function validateContent(raw: unknown, maxChars: number): ContentValidation {
  if (typeof raw !== 'string') {
    return { ok: false, value: '', message: '消息内容必须是字符串。' };
  }
  const value = raw.replace(/\r\n/g, '\n').trim();
  if (value === '') {
    return { ok: false, value: '', message: '消息内容不能为空。' };
  }
  const length = Array.from(value).length;
  if (length > maxChars) {
    return { ok: false, value: '', message: `消息最长 ${maxChars} 个字符，当前 ${length} 个。` };
  }
  return { ok: true, value };
}

export function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

export function parseBeforeRowId(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function normalizeModelId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value === '' ? null : value;
}
