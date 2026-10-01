import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 密码哈希：Node 内置 scrypt（内存硬 KDF）。
 *
 * 取舍：不引入 bcrypt/argon2 原生依赖，避免部署机需要编译工具链；
 * scrypt 是 Node 官方实现且被广泛接受为强口令哈希（N=2^15, r=8, p=1）。
 * 存储格式：scrypt$N$r$p$saltBase64$hashBase64
 */

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** scrypt 需要的内存约为 128 * N * r ≈ 33.5 MB，必须显式放宽 maxmem。 */
const MAX_MEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export const MIN_PASSWORD_LENGTH = 8;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: n,
    r,
    p,
    maxmem: Math.max(MAX_MEM, 128 * n * r * 2),
  });
}

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** 校验一个字符串是否是本模块生成的哈希（用于拒绝把明文写进 LIUYAO_OWNER_PASSWORD_HASH）。 */
export function looksLikePasswordHash(value: string): boolean {
  const parts = value.split('$');
  if (parts.length !== 6) return false;
  if (parts[0] !== 'scrypt') return false;
  return parts.slice(1, 4).every((part) => /^\d+$/.test(part));
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number.parseInt(parts[1] ?? '', 10);
  const r = Number.parseInt(parts[2] ?? '', 10);
  const p = Number.parseInt(parts[3] ?? '', 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64');
    expected = Buffer.from(parts[5] ?? '', 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = derive(password, salt, n, r, p);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * 未配置口令时也要消耗相近的时间，避免通过响应时间判断服务器是否已配置账户。
 */
export function dummyVerify(password: string): void {
  const salt = Buffer.alloc(SALT_LENGTH, 7);
  derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
}
