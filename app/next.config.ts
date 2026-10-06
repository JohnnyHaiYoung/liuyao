import type { NextConfig } from 'next';

/**
 * 第一阶段固定配置 + 第四阶段新增项。
 *
 * - better-sqlite3 是原生模块，必须排除在服务端打包之外（Node 运行时直接 require）。
 * - 不做静态导出：聊天、历史与会话接口都依赖自托管 Node 运行时。
 * - `liuyao-paipan` 是仓库内的阶段 3 排盘模块（app/package.json 里用 file: 依赖软链到 ../paipan）；
 *   它是 TypeScript 源码包，需由 Next 转译后再打进服务端产物，因此列入 transpilePackages。
 *   这样服务端用的是与离线 CLI/自检**同一份**排盘源码，不存在另抄一份实现的风险。
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  transpilePackages: ['liuyao-paipan'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
