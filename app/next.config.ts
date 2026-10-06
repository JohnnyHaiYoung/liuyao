import type { NextConfig } from 'next';

/**
 * 第一阶段固定配置 + 第四阶段新增说明。
 *
 * - better-sqlite3 是原生模块，必须排除在服务端打包之外（Node 运行时直接 require）。
 * - 不做静态导出：聊天、历史与会话接口都依赖自托管 Node 运行时。
 * - 排盘核心以**受校验的源码副本**形式放在 `src/server/chart/vendor/paipan/`
 *   （实测 webpack 无法解析 app 之外的 TypeScript 源码包，故不采用 file: 依赖或跨目录导入）；
 *   一致性由 `node scripts/check-paipan-vendor.mjs` 逐文件 SHA-256 保证。
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
