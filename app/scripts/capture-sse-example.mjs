#!/usr/bin/env node
/**
 * 抓取一段真实的 SSE 响应，作为接口文档里的示例。
 *
 * 用法（服务已启动）：
 *   node scripts/capture-sse-example.mjs --base-url http://127.0.0.1:3100 --out <file>
 * 密码来自 LIUYAO_VERIFY_PASSWORD。
 *
 * 输出文件包含：真实帧的前若干条 + 省略说明 + 最后一条收尾帧。
 * 不会写入任何密钥。
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const baseUrl = argValue('--base-url', process.env.LIUYAO_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const outFile = argValue('--out', '');
const password = argValue('--password', process.env.LIUYAO_VERIFY_PASSWORD ?? '');
const keepHead = Number.parseInt(argValue('--head', '8'), 10);

if (!password) {
  console.error('需要 LIUYAO_VERIFY_PASSWORD（或 --password）。');
  process.exit(2);
}

let cookie = '';
async function call(method, url, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
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
  return response;
}

const login = await call('POST', '/api/auth/login', { password });
if (login.status !== 200) {
  console.error(`登录失败：HTTP ${login.status}`);
  process.exit(1);
}

const conversation = await call('POST', '/api/conversations', {
  clientConversationId: `doc-sample-${randomUUID()}`,
});
const created = await conversation.json();
if (conversation.status !== 200 && conversation.status !== 201) {
  console.error(`创建会话失败：HTTP ${conversation.status} ${JSON.stringify(created).slice(0, 200)}`);
  process.exit(1);
}
const conversationId = created.id;
if (!conversationId) {
  console.error(`创建会话响应缺少 id：${JSON.stringify(created).slice(0, 200)}`);
  process.exit(1);
}

const messageResponse = await call(
  'POST',
  `/api/conversations/${conversationId}/messages`,
  {
    clientMessageId: randomUUID(),
    content: '请用一句话说明：当前版本是否已经接入 Wiki 资料与排盘程序？',
  },
  { accept: 'text/event-stream' },
);

if (messageResponse.status !== 200) {
  console.error(`发送失败：HTTP ${messageResponse.status}`);
  process.exit(1);
}

const reader = messageResponse.body.getReader();
const decoder = new TextDecoder('utf-8');
let buffer = '';
const frames = [];

const boundary = /\r?\n\r?\n/;
function drain() {
  let match = boundary.exec(buffer);
  while (match) {
    frames.push(buffer.slice(0, match.index + match[0].length));
    buffer = buffer.slice(match.index + match[0].length);
    match = boundary.exec(buffer);
  }
}

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  drain();
}
buffer += decoder.decode();
drain();
if (buffer.trim() !== '') frames.push(buffer);

const head = frames.slice(0, keepHead);
const tail = frames.length > keepHead ? frames.slice(-1) : [];
const lines = [
  `# 真实 SSE 抓取（HTTP POST ${baseUrl}/api/conversations/<id>/messages）`,
  `# 抓取时间：${new Date().toISOString()}`,
  `# 帧总数：${frames.length}（事件序列：${[...new Set(frames.map((f) => (/^event:\s*(\S+)/m.exec(f)?.[1] ?? 'comment')))].join(' → ')}）`,
  `# 下面保留前 ${head.length} 帧与最后 1 帧，中间用省略标记代替`,
  '',
  ...head.map((frame) => frame.trimEnd()),
  '',
  `# …（省略 ${Math.max(0, frames.length - head.length - tail.length)} 帧，主要是 delta 增量）…`,
  '',
  ...tail.map((frame) => frame.trimEnd()),
  '',
];

// 终止事件与落库状态检查：避免把“模型调用失败”的抓取当作成功取证
// （阶段 1 复验记录 docs/phase1_reacceptance_2026-10-02.md 的非阻断发现）。
const eventNames = frames.map((f) => /^event:\s*(\S+)/m.exec(f)?.[1]).filter(Boolean);
const hasDone = eventNames.includes('done');
const hasError = eventNames.includes('error');
let assistantStatus = null;
try {
  const listResponse = await call('GET', `/api/conversations/${conversationId}/messages?limit=50`);
  const page = await listResponse.json();
  const assistant = [...(page.items ?? [])].reverse().find((item) => item.role === 'assistant');
  assistantStatus = assistant?.status ?? null;
} catch {
  assistantStatus = null;
}

if (!hasDone || hasError || assistantStatus !== 'completed') {
  console.error(
    `抓取未成功：事件序列 ${eventNames.join(' → ') || '(空)'}，数据库助手状态=${assistantStatus ?? '未知'}。` +
      (hasError ? ' 本次流内出现 error 事件。' : '') +
      ' 未写出示例文件（避免把失败取证当作成功示例）。',
  );
  process.exit(1);
}

if (outFile) {
  fs.writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
  console.log(`已写入 ${outFile}`);
}
console.log(`帧总数 ${frames.length}；会话 ${conversationId}；终止事件 done；数据库状态 ${assistantStatus}`);
