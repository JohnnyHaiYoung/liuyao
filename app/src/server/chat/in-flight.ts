/**
 * 进行中的模型请求登记表。
 *
 * 规则：同一会话同一时间只允许一个进行中的生成；第二个请求直接返回 409。
 * 这是进程内状态（首版单实例），进程重启后由数据库中的 streaming 记录兜底。
 */

export interface InFlightEntry {
  conversationId: string;
  assistantMessageId: string;
  startedAt: number;
  abort: (reason?: string) => void;
}

interface InFlightGlobal {
  __liuyaoInFlight?: Map<string, InFlightEntry>;
}

const globalRef = globalThis as unknown as InFlightGlobal;

function registry(): Map<string, InFlightEntry> {
  if (!globalRef.__liuyaoInFlight) {
    globalRef.__liuyaoInFlight = new Map();
  }
  return globalRef.__liuyaoInFlight;
}

export function isGenerating(conversationId: string): boolean {
  return registry().has(conversationId);
}

export function registerGeneration(entry: InFlightEntry): boolean {
  const map = registry();
  if (map.has(entry.conversationId)) return false;
  map.set(entry.conversationId, entry);
  return true;
}

export function unregisterGeneration(conversationId: string, assistantMessageId?: string): void {
  const current = registry().get(conversationId);
  if (!current) return;
  if (assistantMessageId && current.assistantMessageId !== assistantMessageId) return;
  registry().delete(conversationId);
}

export function abortGeneration(conversationId: string): boolean {
  const entry = registry().get(conversationId);
  if (!entry) return false;
  entry.abort('user_stop');
  return true;
}

export function listGenerating(): InFlightEntry[] {
  return [...registry().values()];
}
