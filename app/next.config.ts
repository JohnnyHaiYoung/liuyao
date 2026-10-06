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
  // 阶段 4：服务端会在运行时按动态路径读取 wiki/、corpus/（目录选页、来源片段、原页图），
  // Next 的静态分析因此会把整个项目纳入追踪，导致 standalone 产物里可能带上聊天库、
  // 资料原件与临时目录。这里显式排除私密/体积大的目录：
  //   · storage/：聊天 SQLite（含 WAL）与临时验证目录，绝不能进产物
  //   · corpus/originals/：原书原件（版权与体积）
  //   · dist/、.git/：发布归档与版本库
  // 运行时仍从项目目录读取这些文件（next start 部署方式），因此排除不影响功能。
  outputFileTracingExcludes: {
    '*': ['./storage/**', './corpus/originals/**', './dist/**', './.git/**', './storage/tmp/**'],
  },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
