/**
 * 阶段 4 浏览器级验收（复验报告要求的两条页面行为）。
 *
 * 覆盖：
 *   1. 跨会话切换：依据必须绑在各自的助手消息上；新建空白会话不得残留上一个会话的证据；
 *      回到旧会话能从历史快照恢复。
 *   2. 输入问题后**切换模型并立刻发送**：实际发出的请求体必须已是新模型，且模拟上游确实收到该模型的调用。
 *
 * 不覆盖（如实说明）：真实 API 联调、视觉/样式回归、移动端布局。
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const runtime = JSON.parse(fs.readFileSync(path.join(__dirname, '.runtime.json'), 'utf8')) as {
  baseUrl: string;
  mockBaseUrl: string;
  password: string;
};

const COMPOSER = 'textarea[placeholder^="输入问题"]';

type MockStats = {
  calls: Record<string, number>;
  sawWikiEvidence?: boolean;
  lastSid?: string | null;
  lastBodyLength?: number;
};

async function mockStats(): Promise<MockStats> {
  const response = await fetch(`${runtime.mockBaseUrl}/__stats`);
  return (await response.json()) as MockStats;
}

async function login(page: Page): Promise<void> {
  await page.goto(`${runtime.baseUrl}/login`);
  await page.fill('#password', runtime.password);
  await page.click('button[type="submit"]');
  await expect(page.locator(COMPOSER)).toBeVisible();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const before = await page.locator('article.message.assistant').count();
  await page.fill(COMPOSER, text);
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('article.message.assistant')).toHaveCount(before + 1);
  await expect(page.locator('article.message.assistant').last().getByText('正在生成')).toHaveCount(0);
}

test('依据跟随各自消息，切换/新建会话不残留、回看仍在', async ({ page }) => {
  await login(page);

  // 概念问题：服务端会送出候选证据，模拟上游引用首个编号 → 该条助手消息应显示"展开依据"
  await sendMessage(page, '什么是用神？');

  const stats = await mockStats();
  console.log(
    `[诊断] 上游是否看到编号证据=${stats.sawWikiEvidence} 编号=${stats.lastSid} 请求体长度=${stats.lastBodyLength} 调用=${JSON.stringify(stats.calls)}`,
  );
  expect(stats.calls['deepseek-flash'] ?? 0).toBeGreaterThan(0);

  const assistant = page.locator('article.message.assistant').last();
  await expect(assistant.locator('.message-evidence')).toBeVisible();
  await expect(assistant.locator('.message-evidence')).toContainText('展开依据');
  await expect(assistant.locator('.message-evidence')).toContainText('只来自服务端选中');

  const titleText = (await page.locator('.conversation-item.active .conversation-title').first().innerText()).trim();
  expect(titleText.length).toBeGreaterThan(0);

  // 新建空白会话：不得残留上一个会话的证据
  await page.getByRole('button', { name: '+ 新建聊天' }).click();
  await expect(page.locator('article.message.assistant')).toHaveCount(0);
  await expect(page.locator('.message-evidence')).toHaveCount(0);

  // 在第二个会话里也发一条（复验报告 2250d0d「测试边界」）：两个**都有内容**的会话互切不得串话
  await sendMessage(page, '什么是六爻？');
  await expect(page.locator('article.message.assistant')).toHaveCount(1);
  await expect(page.locator('.message-evidence')).toHaveCount(1);
  await expect(page.locator('.messages')).toContainText('什么是六爻？');
  await expect(page.locator('.messages')).not.toContainText('什么是用神？');

  // 回到旧会话：历史快照仍应显示自己的依据，且只有自己那一条消息
  await page.locator('.conversation-item', { hasText: titleText }).first().click();
  await expect(page.locator('article.message.assistant')).toHaveCount(1);
  await expect(page.locator('article.message.assistant .message-evidence').first()).toBeVisible();
  await expect(page.locator('.messages')).toContainText('什么是用神？');
  await expect(page.locator('.messages')).not.toContainText('什么是六爻？');
});

test('输入后切换模型立刻发送：请求体与上游调用都用新模型', async ({ page }) => {
  await login(page);

  const requestedModels: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/messages')) {
      try {
        const body = JSON.parse(request.postData() ?? '{}') as { model?: string };
        if (body.model) requestedModels.push(body.model);
      } catch {
        /* 忽略非 JSON 请求体 */
      }
    }
  });

  await page.fill(COMPOSER, '什么是用神？请一句话说明。');
  await expect(page.locator('#model-select')).toBeVisible();
  await page.selectOption('#model-select', 'qwen3.7-plus');
  // 立刻发送：不给 React 重新渲染留时间（这正是原先竞态会出错的时机）
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.locator('article.message.assistant').last().locator('.bubble')).toContainText('最终结果', { timeout: 30_000 });
  expect(requestedModels.length).toBeGreaterThan(0);
  expect(requestedModels[0]).toBe('qwen3.7-plus');

  // 反向证明未打真实 API：模拟上游确实收到了千问的调用
  const stats = await mockStats();
  expect(stats.calls['qwen3.7-plus'] ?? 0).toBeGreaterThan(0);
});
