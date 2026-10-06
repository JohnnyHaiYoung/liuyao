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
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = path.join(APP_ROOT, 'src');

export async function resolve(specifier, context, nextResolve) {
  // tsconfig 的 `@/*` → `app/src/*`（Next 构建认得，Node 不认得）
  if (specifier.startsWith('@/')) {
    const base = path.join(SRC_ROOT, specifier.slice(2));
    for (const candidate of ['', ...CANDIDATES]) {
      const target = base + candidate;
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        return nextResolve(pathToFileURL(target).href, context);
      }
    }
  }
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
