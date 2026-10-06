/** 注册 TypeScript 解析钩子（见 ts-resolve-hook.mjs 的说明）。 */
import { register } from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);
