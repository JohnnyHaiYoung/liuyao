import type { NextConfig } from 'next';

/**
 * 第一阶段固定配置。
 *
 * - better-sqlite3 是原生模块，必须排除在服务端打包之外（Node 运行时直接 require）。
 * - 不做静态导出：聊天、历史与会话接口都依赖自托管 Node 运行时。
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
