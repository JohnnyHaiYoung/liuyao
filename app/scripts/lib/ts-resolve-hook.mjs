/**
 * Node ESM 解析钩子：把无扩展名的相对导入解析到 .ts/.tsx/index.ts。
 *
 * 用途：app/src 下的服务端模块按 Next 习惯写无后缀相对导入（`../config`）。Next 构建能解析，
 * 但 Node ESM 不能。这个钩子让**离线自检脚本可以直接复用 app 的真实模块**（真实迁移器、真实
 * 快照层），而不是在脚本里另抄一份实现。
 *
 * 用法：node --import ./app/scripts/lib/register-ts.mjs app/scripts/<check>.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : null;
      if (base) {
        for (const candidate of CANDIDATES) {
          const candidateUrl = new URL(base.href + candidate);
          if (fs.existsSync(fileURLToPath(candidateUrl))) {
            return nextResolve(candidateUrl.href, context);
          }
        }
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}
