import { defineConfig } from '@playwright/test';

/**
 * 浏览器级验收（阶段 4 复验要求）。
 *
 * 全部使用**隔离测试库 + 模拟上游**：不接触正式库、不调用真实 API、不依赖网络与密钥。
 * 服务与临时库的起停由 e2e/global-setup.ts 负责（见该文件注释）。
 * 前置：先 `npm run build`（测试跑 `next start` 的生产构建）。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    // 复用本机已安装的 Chrome，避免下载 Playwright 自带浏览器（受网络限制时不可用）。
    // 无 Chrome 的机器可改成 'msedge'，或先 `npx playwright install chromium` 后删除本行。
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
