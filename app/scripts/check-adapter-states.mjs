#!/usr/bin/env node
/**
 * 适配层四态回归：用可控模拟上游验证终止语义（验收报告 2026-10-02 第 1 条的修复标准）。
 *
 * 前置：应用指向模拟上游运行，例如
 *   LLM_BASE_URL=http://127.0.0.1:3211/v1  DEEPSEEK_API_KEY=sk-mock  pnpm start
 * 用法：
 *   node scripts/check-adapter-states.mjs --base-url http://127.0.0.1:3210 --mock-url http://127.0.0.1:3211
 *
 * 断言的是「浏览器收到的事件序列」+「数据库里保存的状态」，两者都要正确：
 *   正常结束 -> done  + completed
 *   提前 EOF -> error + failed(upstream_truncated)
 *   连接重置 -> error + failed(upstream_error)
 *   上游 5xx -> error + failed(upstream_unavailable)
 *   上游 401 -> error + failed(upstream_auth_error)
 *   长度上限 -> done  + completed(output_limit_reached)
 *   用户中断 -> 无终止事件 + interrupted
 */

import { randomUUID } from 'node:crypto';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseUrl = argValue('--base-url', process.env.LIUYAO_BASE_URL ?? 'http://127.0.0.1:3210').replace(/\/+$/, '');
const mockUrl = argValue('--mock-url', 'http://127.0.0.1:3211').replace(/\/+$/, '');
const password = argValue('--password', process.env.LIUYAO_VERIFY_PASSWORD ?? '');

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

async function setMockMode(mode) {
  const response = await fetch(`${mockUrl}/__control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`无法切换模拟上游模式：HTTP ${response.status}`);
  return (await response.json()).mode;
}

function createSseCollector() {
  const events = [];
  let buffer = '';
  const boundary = /\r?\n\r?\n/;
  return {
    events,
    push(chunk) {
      buffer += chunk;
      let match = boundary.exec(buffer);
      while (match) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        let event = 'message';
        const dataLines = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length > 0) {
          let payload = null;
          try {
            payload = JSON.parse(dataLines.join('\n'));
          } catch {
            payload = null;
          }
          events.push({ event, payload });
        }
        match = boundary.exec(buffer);
      }
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendAndCollect(conversationId, options = {}) {
  const collector = createSseCollector();
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({ clientMessageId: randomUUID(), content: '四态回归测试' }),
    signal: controller.signal,
  });
  if (response.status !== 200) {
    return { httpStatus: response.status, events: [], body: await response.text() };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collector.push(decoder.decode(value, { stream: true }));
      if (options.abortAfterFirstDelta && collector.events.some((item) => item.event === 'delta')) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    collector.push(decoder.decode());
  } catch {
    /* 主动中断时读取会抛错，属预期 */
  }
  return { httpStatus: 200, events: collector.events };
}

async function assistantState(conversationId) {
  const response = await call('GET', `/api/conversations/${conversationId}/messages?limit=50`);
  const body = await response.json();
  const assistant = [...(body.items ?? [])].reverse().find((item) => item.role === 'assistant');
  return assistant ?? null;
}

const CASES = [
  { mode: 'normal', expectStatus: 'completed', expectError: null, expectTerminal: 'done', label: '正常结束' },
  { mode: 'eof', expectStatus: 'failed', expectError: 'upstream_truncated', expectTerminal: 'error', label: '提前 EOF（无 [DONE]、无 finish_reason）' },
  { mode: 'reset', expectStatus: 'failed', expectError: 'upstream_error', expectTerminal: 'error', label: '连接被重置' },
  { mode: 'http500', expectStatus: 'failed', expectError: 'upstream_unavailable', expectTerminal: 'error', label: '上游 5xx' },
  { mode: 'http401', expectStatus: 'failed', expectError: 'upstream_auth_error', expectTerminal: 'error', label: '上游 401' },
  { mode: 'length', expectStatus: 'completed', expectError: 'output_limit_reached', expectTerminal: 'done', label: '达到 max_tokens' },
  { mode: 'empty', expectStatus: 'completed', expectError: null, expectTerminal: 'done', label: '无正文但正常结束' },
  { mode: 'slow', expectStatus: 'interrupted', expectError: 'client_aborted', expectTerminal: null, label: '用户停止生成' },
];

const login = await call('POST', '/api/auth/login', { password });
if (login.status !== 200) {
  console.error(`登录失败：HTTP ${login.status}`);
  process.exit(2);
}

const results = [];
for (const testCase of CASES) {
  await setMockMode(testCase.mode);
  const conversation = await call('POST', '/api/conversations', {
    clientConversationId: `adapter-${testCase.mode}-${randomUUID()}`,
  });
  const conversationId = (await conversation.json()).id;

  const { events, httpStatus } = await sendAndCollect(conversationId, {
    abortAfterFirstDelta: testCase.mode === 'slow',
  });

  if (testCase.mode === 'slow') {
    // 等服务器把 interrupted 写定
    await sleep(1500);
  }

  const state = await assistantState(conversationId);
  const eventNames = events.map((item) => item.event);
  const terminal = eventNames.includes('done') ? 'done' : eventNames.includes('error') ? 'error' : null;
  const errorCode = state?.errorCode ?? null;

  const problems = [];
  if (httpStatus !== 200) problems.push(`HTTP ${httpStatus}`);
  if (state?.status !== testCase.expectStatus) problems.push(`状态=${state?.status} 期望=${testCase.expectStatus}`);
  if ((errorCode ?? null) !== (testCase.expectError ?? null)) {
    problems.push(`errorCode=${errorCode ?? '-'} 期望=${testCase.expectError ?? '-'}`);
  }
  if (testCase.expectTerminal !== null && terminal !== testCase.expectTerminal) {
    problems.push(`终止事件=${terminal ?? '-'} 期望=${testCase.expectTerminal}`);
  }
  if (testCase.expectTerminal === null && terminal !== null) {
    problems.push(`用户中断不应有终止事件，实际收到 ${terminal}`);
  }
  // 只要浏览器已经收到过正文增量，这部分内容就必须被保存下来（无论最终状态是什么）。
  if (eventNames.includes('delta') && (state?.content ?? '').length === 0) {
    problems.push('已经推送给浏览器的部分正文没有被保存');
  }
  if (testCase.mode === 'eof' && state?.status === 'completed') {
    problems.push('截断的响应被标记为 completed');
  }

  results.push({ label: testCase.label, mode: testCase.mode, ok: problems.length === 0, detail: problems.join('；'), eventNames, state });
  const mark = problems.length === 0 ? '通过' : '未通过';
  console.log(
    `[${mark}] ${testCase.label}：事件=${eventNames.join('→') || '-'} 状态=${state?.status ?? '-'} errorCode=${errorCode ?? '-'} 正文长度=${(state?.content ?? '').length}` +
      (problems.length > 0 ? `  ← ${problems.join('；')}` : ''),
  );
}

const failed = results.filter((item) => !item.ok);
console.log('');
console.log(`适配层四态回归：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length > 0) process.exitCode = 1;
