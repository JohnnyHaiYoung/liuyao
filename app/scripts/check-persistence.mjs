#!/usr/bin/env node
/**
 * 重启后历史仍在的复核脚本（黑盒 HTTP）。
 *
 * 用法：
 *   node scripts/check-persistence.mjs --base-url http://127.0.0.1:3100
 * 密码来自环境变量 LIUYAO_VERIFY_PASSWORD。
 *
 * 它只读取，不写入：登录 → 列出会话 → 打印最近会话的消息条数与各状态数量。
 */

import { projectRoot, storageDir } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const baseUrl = argValue('--base-url', process.env.LIUYAO_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const password = argValue('--password', process.env.LIUYAO_VERIFY_PASSWORD ?? '');
const storage = argValue('--storage', storageDir());

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

if (!password) {
  console.error('需要 LIUYAO_VERIFY_PASSWORD（或 --password）才能登录复核。');
  process.exit(2);
}

const login = await call('POST', '/api/auth/login', { password });
if (login.status !== 200) {
  console.error(`登录失败：HTTP ${login.status}`);
  process.exit(1);
}

const list = await call('GET', '/api/conversations?limit=50');
const items = list.json.items ?? [];
console.log(`重启后仍可登录，历史会话 ${items.length} 条：`);
let totalMessages = 0;
for (const item of items.slice(0, 5)) {
  const messages = await call('GET', `/api/conversations/${item.id}/messages?limit=200`);
  const list2 = messages.json.items ?? [];
  totalMessages += list2.length;
  const statuses = list2.reduce((accumulator, message) => {
    accumulator[message.status] = (accumulator[message.status] ?? 0) + 1;
    return accumulator;
  }, {});
  const models = [...new Set(list2.filter((m) => m.role === 'assistant' && m.model).map((m) => m.model))];
  console.log(
    `  - 「${item.title}」 消息 ${list2.length} 条，状态 ${JSON.stringify(statuses)}，模型 ${models.join(',') || '-'}，更新时间 ${item.updatedAt}`,
  );
}
const dbFile = path.join(storage, 'liuyao.db');
console.log(
  `数据库文件：${path.relative(projectRoot, dbFile)}（${fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0} 字节）`,
);
console.log(`本次抽查的消息总数：${totalMessages}`);
