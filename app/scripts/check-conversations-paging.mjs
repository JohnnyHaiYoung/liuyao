#!/usr/bin/env node
/**
 * 历史列表分页验收：确认第 51 条及更早的会话在接口层可见、可打开、可继续、可重命名。
 * （验收报告 2026-10-02 第 3 条的修复标准；界面上的按钮点击仍需人工看一眼。）
 *
 * 前置：先跑 scripts/seed-conversations.mjs 造出 ≥51 条会话，并让应用运行在假模型或模拟上游上
 * （“继续”这一步会真的发一条消息）。
 *
 * 用法：
 *   node scripts/check-conversations-paging.mjs --base-url http://127.0.0.1:3100 [--expect-oldest "种子会话 55"]
 */

import { randomUUID } from 'node:crypto';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseUrl = argValue('--base-url', process.env.LIUYAO_BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const password = argValue('--password', process.env.LIUYAO_VERIFY_PASSWORD ?? '');
const pageSize = Number.parseInt(argValue('--page-size', '20'), 10);
const seedPrefix = argValue('--seed-prefix', '种子会话');
const oldestIndex = Number.parseInt(argValue('--expect-oldest-index', '0'), 10);
// 种子脚本的编号规则：种子会话 01 最新，编号最大的一条最早。
const expectOldest = argValue(
  '--expect-oldest',
  oldestIndex > 0 ? `${seedPrefix} ${String(oldestIndex).padStart(2, '0')}` : '',
);

if (!password) {
  console.error('需要 LIUYAO_VERIFY_PASSWORD（或 --password）。');
  process.exit(2);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? '通过' : '未通过'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

let cookie = '';
async function call(method, url, body) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0];
    if (pair) cookie = pair;
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, json };
}

const login = await call('POST', '/api/auth/login', { password });
if (login.status !== 200) {
  console.error(`登录失败：HTTP ${login.status}`);
  process.exit(2);
}

// 1) 逐页读取，直到 cursor 为空；记录每页数量与累计数量。
const collected = [];
const pageIds = [];
let cursor = null;
let pages = 0;
do {
  const query = new URLSearchParams({ limit: String(pageSize) });
  if (cursor) query.set('cursor', cursor);
  const page = await call('GET', `/api/conversations?${query.toString()}`);
  if (page.status !== 200) {
    record('分页读取历史列表', false, `HTTP ${page.status}`);
    break;
  }
  const items = page.json.items ?? [];
  pages += 1;
  pageIds.push(items.map((item) => item.title));
  collected.push(...items);
  cursor = page.json.nextCursor ?? null;
  if (pages > 30) break; // 安全阀
} while (cursor);

record('分页读取历史列表', pages > 1, `共 ${pages} 页，累计 ${collected.length} 条`);
record(
  '第 51 条及更早的会话出现在后续页',
  collected.length >= 51,
  `累计 ${collected.length} 条（第一页 ${pageIds[0]?.length ?? 0} 条）`,
);

const oldestSeeded = [...collected].reverse().find((item) => item.title.startsWith('种子会话')) ?? null;
const expected = expectOldest
  ? collected.find((item) => item.title === expectOldest) ?? null
  : oldestSeeded;
record(
  '最早一条种子会话已加载',
  Boolean(expected),
  expected ? `${expected.title}（第 ${pageIds.findIndex((titles) => titles.includes(expected.title)) + 1} 页）` : '未找到',
);

if (expected) {
  // 2) 打开：读取消息
  const messages = await call('GET', `/api/conversations/${expected.id}/messages?limit=50`);
  const items = messages.json.items ?? [];
  record('可打开最早一条会话', messages.status === 200 && items.length > 0, `HTTP ${messages.status}，消息 ${items.length} 条`);

  // 3) 重命名
  const rename = await call('PATCH', `/api/conversations/${expected.id}`, { title: `${expected.title}（分页验收改名）` });
  record(
    '可重命名最早一条会话',
    rename.status === 200 && rename.json?.conversation?.titleSource === 'manual',
    `HTTP ${rename.status} title=${rename.json?.conversation?.title ?? '-'}`,
  );

  // 4) 继续对话（需要模型可用：假模型或模拟上游）
  const before = (await call('GET', `/api/conversations/${expected.id}/messages?limit=100`)).json.items?.length ?? 0;
  const send = await fetch(`${baseUrl}/api/conversations/${expected.id}/messages`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ clientMessageId: randomUUID(), content: '分页验收：继续这条最早的会话。' }),
  });
  let terminal = null;
  if (send.status === 200) {
    const text = await send.text();
    terminal = text.includes('event: done') ? 'done' : text.includes('event: error') ? 'error' : null;
  }
  const after = (await call('GET', `/api/conversations/${expected.id}/messages?limit=200`)).json.items?.length ?? 0;
  record(
    '可继续最早一条会话',
    send.status === 200 && after > before,
    `HTTP ${send.status} 终止事件=${terminal ?? '-'}，消息 ${before} → ${after} 条`,
  );
}

const failed = results.filter((item) => !item.ok);
console.log('');
console.log(`历史列表分页验收：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length > 0) process.exitCode = 1;
