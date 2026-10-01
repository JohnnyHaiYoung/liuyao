#!/usr/bin/env node
/**
 * 生成拥有者密码哈希，用于服务器环境变量 LIUYAO_OWNER_PASSWORD_HASH。
 *
 * 用法（推荐通过标准输入传入，避免留在命令历史里）：
 *   echo "你的密码" | npm run hash-password
 *   npm run hash-password -- "你的密码"
 *
 * 参数必须与 app/src/server/auth/password.ts 保持一致；
 * `npm run verify:phase1` 会用它生成哈希并用真实登录流程校验，防止两边漂移。
 */

import { randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), derived.toString('base64')].join('$');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  let password = process.argv[2] ?? '';
  if (!password) {
    if (process.stdin.isTTY) {
      console.error('用法：echo "密码" | npm run hash-password    或    npm run hash-password -- "密码"');
      process.exitCode = 2;
      return;
    }
    password = await readStdin();
  }
  if (password === '') {
    console.error('密码不能为空。');
    process.exitCode = 2;
    return;
  }
  if (password.length < 8) {
    console.error('提示：密码建议至少 8 位。已按要求生成，但请自行评估强度。');
  }
  const hash = hashPassword(password);
  console.log(hash);
  console.error('');
  console.error('把上面这一行写入服务器的 LIUYAO_OWNER_PASSWORD_HASH（不要写入代码库或数据库）。');
  console.error('设置后重启服务，启动时会按环境变量创建/更新拥有者账户。');
}

// 只有直接执行本文件时才生成哈希；被 verify 脚本 import 时只导出函数。
if (path.basename(process.argv[1] ?? '') === 'hash-password.mjs') {
  await main();
}
