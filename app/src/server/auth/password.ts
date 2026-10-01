import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 密码哈希：Node 内置 scrypt（内存硬 KDF）。
 *
 * 存储格式（推荐，`$`-free）：
 *     scrypt:N:r:p:saltBase64:hashBase64
 *
 * 为什么不用 `$` 分隔：`$` 在两个常见环节会被展开/截断，导致登录永远失败——
 *   1. Next.js 读 `.env*` 文件时会对值做变量展开：`scrypt$32768$8$1$salt$hash`
 *      会被替换成 `scrypt==...`（`$32768`、`$8`、`$1` 被当作未定义变量）；
 *   2. PowerShell 双引号字符串 `"scrypt$32768$..."` 同样会吞掉 `$`。
 * 冒号格式在三处（.env 文件、shell、systemd EnvironmentFile）都是字面值。
 *
 * 兼容旧格式：`scrypt$N$r$p$salt$hash` 仍然可以校验，但写在 `.env` 文件里时
 * 必须把每个 `$` 写成 `\$`。
 */

const SCHEME = 'scrypt';
const DEFAULT_SEPARATOR = ':';
const LEGACY_SEPARATOR = '$';
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** scrypt 需要的内存约为 128 * N * r ≈ 33.5 MB，必须显式放宽 maxmem。 */
const MAX_MEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export const MIN_PASSWORD_LENGTH = 8;

export type HashSeparator = typeof DEFAULT_SEPARATOR | typeof LEGACY_SEPARATOR;

export interface ParsedPasswordHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
  separator: HashSeparator;
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: n,
    r,
    p,
    maxmem: Math.max(MAX_MEM, 128 * n * r * 2),
  });
}

/** 解析两种分隔符形式；返回 null 表示格式不可用。 */
export function parseEncodedHash(value: string): ParsedPasswordHash | null {
  const normalized = value.trim();
  const separator: HashSeparator | null = normalized.includes(LEGACY_SEPARATOR)
    ? LEGACY_SEPARATOR
    : normalized.includes(DEFAULT_SEPARATOR)
      ? DEFAULT_SEPARATOR
      : null;
  if (!separator) return null;

  const parts = normalized.split(separator);
  if (parts.length !== 6 || parts[0] !== SCHEME) return null;

  const n = Number.parseInt(parts[1] ?? '', 10);
  const r = Number.parseInt(parts[2] ?? '', 10);
  const p = Number.parseInt(parts[3] ?? '', 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return null;
  if (n < 2 || r < 1 || p < 1) return null;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64');
    expected = Buffer.from(parts[5] ?? '', 'base64');
  } catch {
    return null;
  }
  if (salt.length === 0 || expected.length === 0) return null;

  return { n, r, p, salt, expected, separator };
}

export function hashPassword(password: string, separator: HashSeparator = DEFAULT_SEPARATOR): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    SCHEME,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join(separator);
}

/** 校验一个字符串是否是本模块生成的哈希（用于拒绝把明文写进 LIUYAO_OWNER_PASSWORD_HASH）。 */
export function looksLikePasswordHash(value: string): boolean {
  return parseEncodedHash(value) !== null;
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  const parsed = parseEncodedHash(encodedHash);
  if (!parsed) return false;
  let actual: Buffer;
  try {
    actual = derive(password, parsed.salt, parsed.n, parsed.r, parsed.p);
  } catch {
    return false;
  }
  if (actual.length !== parsed.expected.length) return false;
  return timingSafeEqual(actual, parsed.expected);
}

/**
 * 给启动日志用的排错提示：说明为什么这个值不可用、下一步该怎么做。
 * 只返回格式层面的信息，不回显用户提供的值。
 */
export function hashProblemHint(value: string): string {
  if (value !== value.trim()) {
    return '值的前后有空白字符或引号，请去掉。';
  }
  if (!value.startsWith(SCHEME)) {
    return `应以 "${SCHEME}" 开头；请用 npm run hash-password 重新生成。`;
  }
  const separator = value.includes(LEGACY_SEPARATOR) ? LEGACY_SEPARATOR : DEFAULT_SEPARATOR;
  const parts = value.split(separator);
  if (parts.length !== 6) {
    return (
      `分隔符数量为 ${parts.length}（应为 6）。常见原因：写在 .env 文件里的 ${LEGACY_SEPARATOR} 被 Next 的变量展开吃掉。` +
      ' 请改用 npm run hash-password 现在输出的冒号格式 scrypt:N:r:p:salt:hash；' +
      ` 若必须用旧格式，请把每个 ${LEGACY_SEPARATOR} 写成 \\${LEGACY_SEPARATOR}。`
    );
  }
  return '数值或 base64 部分无法解析，请用 npm run hash-password 重新生成。';
}

/**
 * 未配置口令时也要消耗相近的时间，避免通过响应时间判断服务器是否已配置账户。
 */
export function dummyVerify(password: string): void {
  const salt = Buffer.alloc(SALT_LENGTH, 7);
  derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
}
