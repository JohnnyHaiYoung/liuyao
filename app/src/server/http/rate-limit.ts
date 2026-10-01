/**
 * 进程内限流（固定窗口）。
 *
 * 取舍：首版是单用户单实例，不需要 Redis 等外部依赖；
 * 进程重启会清空计数，这对“防暴力破解”和“防误触刷屏”已经足够。
 * 若将来多实例部署，需要替换为共享存储。
 */

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimitGlobal {
  __liuyaoRateLimits?: Map<string, Bucket>;
}

const globalRef = globalThis as unknown as RateLimitGlobal;

function buckets(): Map<string, Bucket> {
  if (!globalRef.__liuyaoRateLimits) {
    globalRef.__liuyaoRateLimits = new Map();
  }
  return globalRef.__liuyaoRateLimits;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** 桶数量上限：即使键被外部影响，也不会无限增长。 */
const MAX_BUCKETS = 10000;

export function consume(key: string, limit: number, windowMs: number): RateLimitResult {
  const store = buckets();
  const now = Date.now();
  if (store.size >= MAX_BUCKETS) {
    sweep();
    if (store.size >= MAX_BUCKETS) evictOldest();
  }
  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

/** 登录成功等场景下清除计数。 */
export function reset(key: string): void {
  buckets().delete(key);
}

/** 定期清理过期桶，避免长期运行后内存增长。 */
export function sweep(): void {
  const store = buckets();
  const now = Date.now();
  for (const [key, bucket] of store) {
    if (bucket.resetAt <= now) store.delete(key);
  }
}

/** 仍然超限时淘汰最早过期的桶（极端情况下的兜底）。 */
function evictOldest(): void {
  const store = buckets();
  let oldestKey: string | null = null;
  let oldestReset = Number.POSITIVE_INFINITY;
  for (const [key, bucket] of store) {
    if (bucket.resetAt < oldestReset) {
      oldestReset = bucket.resetAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) store.delete(oldestKey);
}
