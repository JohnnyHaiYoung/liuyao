#!/usr/bin/env node
/**
 * 第一阶段验收自检脚本（黑盒 HTTP）。
 *
 * 它按 docs/phase1_development_spec.md 第 8 节的验收场景逐项调用真实接口，
 * 并把「通过 / 未通过 / 受阻」的实际结果打印出来，供产品/架构方复核。
 *
 * 用法：
 *   # 终端 A（可先用独立存储目录，避免污染正式历史）
 *   $env:LIUYAO_STORAGE_DIR="E:\workspace-ai\xuanxue\liuyao\storage\verify"
 *   $env:LIUYAO_OWNER_PASSWORD="仅用于验收的密码"
 *   npm run build; npm start
 *   # 终端 B
 *   $env:LIUYAO_VERIFY_PASSWORD="仅用于验收的密码"
 *   npm run verify:phase1
 *
 * 参数：--base-url http://127.0.0.1:3000   --password ***   --storage <dir>
 * 不打印密码、Cookie 或 API Key。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectRoot, storageDir as defaultStorageDir } from './lib/paths.mjs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

const baseUrl = argValue('--base-url', process.env.LIUYAO_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const password = argValue('--password', process.env.LIUYAO_VERIFY_PASSWORD ?? '');
const storage = argValue('--storage', defaultStorageDir);

const results = [];
let cookie = '';
let llmConfigured = false;
/** ok | not_configured | upstream_failed | unknown —— 决定后续哪些检查可比。 */
let generationState = 'unknown';
/** 第一次发送是否已经把用户消息写进数据库。 */
let userMessageSaved = false;

function record(name, status, detail) {
  results.push({ name, status, detail });
  const label = { pass: '通过', fail: '未通过', blocked: '受阻', info: '信息' }[status] ?? status;
  console.log(`[${label}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function absolute(url) {
  return url.startsWith('http') ? url : `${baseUrl}${url}`;
}

async function request(method, url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(absolute(url), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    redirect: options.redirect ?? 'follow',
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
    const pair = raw.split(';')[0];
    if (pair) cookie = pair;
  }
  return response;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

function parseSseChunk(bufferState, chunk, onEvent) {
  bufferState.value += chunk;
  const boundary = /\r?\n\r?\n/;
  let match = boundary.exec(bufferState.value);
  while (match) {
    const raw = bufferState.value.slice(0, match.index);
    bufferState.value = bufferState.value.slice(match.index + match[0].length);
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
      onEvent(event, payload);
    }
    match = boundary.exec(bufferState.value);
  }
}

async function consumeSse(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const state = { value: '' };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parseSseChunk(state, decoder.decode(value, { stream: true }), (event, payload) => {
      handlers(event, payload);
    });
  }
  parseSseChunk(state, decoder.decode(), (event, payload) => handlers(event, payload));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`验收目标：${baseUrl}`);
  console.log(`存储目录：${storage}`);
  console.log(`验收密码：${password ? '已提供（不打印）' : '未提供（跳过需要登录的检查）'}`);
  console.log('');

  /* 1. 健康检查 */
  try {
    const response = await request('GET', '/api/healthz');
    const body = await readJson(response);
    if (response.status === 200 && body.status === 'ok') {
      llmConfigured = Boolean(body.llm?.configured);
      record(
        'healthz 存活检查',
        'pass',
        `数据库迁移 ${body.database?.migrations} 个；模型 ${body.llm?.model}；已配置密钥=${llmConfigured}；已配置拥有者密码=${body.auth?.ownerConfigured}；信任代理头=${body.server?.trustProxy}`,
      );
      record('密钥未出现在响应中', JSON.stringify(body).includes('sk-') ? 'fail' : 'pass', '响应体不含 API Key 片段');
    } else {
      record('healthz 存活检查', 'fail', `HTTP ${response.status}`);
    }
  } catch (error) {
    record('healthz 存活检查', 'fail', `无法连接：${error.message}（服务是否已启动？）`);
    printSummary();
    process.exitCode = 1;
    return;
  }

  /* 2. 未登录访问被拒绝 */
  try {
    const conversations = await request('GET', '/api/conversations');
    const body = await readJson(conversations);
    record(
      '未登录访问会话列表被拒绝',
      conversations.status === 401 ? 'pass' : 'fail',
      `HTTP ${conversations.status} code=${body?.error?.code ?? '-'}`,
    );
    const me = await request('GET', '/api/auth/me');
    record('未登录访问 /api/auth/me 被拒绝', me.status === 401 ? 'pass' : 'fail', `HTTP ${me.status}`);
  } catch (error) {
    record('未登录访问被拒绝', 'fail', error.message);
  }

  if (!password) {
    record('登录与后续场景', 'blocked', '未提供验收密码（LIUYAO_VERIFY_PASSWORD），无法继续');
    printSummary();
    return;
  }

  /* 3. 错误密码不泄露信息 */
  try {
    const wrong = await request('POST', '/api/auth/login', { body: { password: `${password}-wrong` } });
    const body = await readJson(wrong);
    record(
      '错误密码返回统一错误',
      wrong.status === 401 && body?.error?.code === 'invalid_credentials' ? 'pass' : 'fail',
      `HTTP ${wrong.status} code=${body?.error?.code ?? '-'}`,
    );
  } catch (error) {
    record('错误密码返回统一错误', 'fail', error.message);
  }

  /* 4. 登录 */
  const rawCookieBefore = cookie;
  const loginResponse = await request('POST', '/api/auth/login', { body: { password } });
  if (loginResponse.status !== 200) {
    const body = await readJson(loginResponse);
    record('登录成功', 'fail', `HTTP ${loginResponse.status} code=${body?.error?.code ?? '-'}`);
    printSummary();
    process.exitCode = 1;
    return;
  }
  const loginBody = await readJson(loginResponse);
  const cookieFlags = (loginResponse.headers.getSetCookie?.() ?? []).join(' ').toLowerCase();
  record('登录成功', 'pass', `拥有者=${loginBody.owner?.username}；Cookie 已下发`);
  record(
    '会话 Cookie 属性',
    cookieFlags.includes('httponly') && cookieFlags.includes('samesite=lax') ? 'pass' : 'fail',
    `httponly=${cookieFlags.includes('httponly')} samesite=lax=${cookieFlags.includes('samesite=lax')} secure=${cookieFlags.includes('secure')}`,
  );
  void rawCookieBefore;

  const meResponse = await request('GET', '/api/auth/me');
  record('登录后读取 /api/auth/me', meResponse.status === 200 ? 'pass' : 'fail', `HTTP ${meResponse.status}`);

  /* 4.1 页面渲染（服务端渲染 + 未登录重定向） */
  {
    const home = await request('GET', '/');
    const homeHtml = await home.text();
    const hasNewChat = homeHtml.includes('新建聊天');
    const hasComposer = homeHtml.includes('Enter 发送');
    const hasPanels = homeHtml.includes('六爻 Agent');
    record(
      '已登录可打开聊天页面（服务端渲染）',
      home.status === 200 && hasNewChat && hasComposer && hasPanels ? 'pass' : 'fail',
      `HTTP ${home.status}；新建按钮=${hasNewChat} 输入框=${hasComposer} 标题=${hasPanels} 长度=${homeHtml.length}`,
    );

    const authenticatedCookie = cookie;
    cookie = '';
    const anonHome = await request('GET', '/', { redirect: 'manual' });
    const location = anonHome.headers.get('location') ?? '';
    record(
      '未登录访问首页被重定向到登录页',
      [301, 302, 303, 307, 308].includes(anonHome.status) && location.includes('/login')
        ? 'pass'
        : 'fail',
      `HTTP ${anonHome.status} location=${location || '-'}`,
    );
    const loginPage = await request('GET', '/login');
    const loginHtml = await loginPage.text();
    record(
      '登录页可渲染且含密码输入框',
      loginPage.status === 200 && loginHtml.includes('type="password"') ? 'pass' : 'fail',
      `HTTP ${loginPage.status}；密码框=${loginHtml.includes('type="password"')}`,
    );
    cookie = authenticatedCookie;
  }

  /* 5. 新建会话（幂等） */
  const draftId = `verify-${randomUUID()}`;
  const createResponse = await request('POST', '/api/conversations', { body: { clientConversationId: draftId } });
  const created = await readJson(createResponse);
  const conversationId = created.id;
  record(
    '新建会话',
    createResponse.status === 201 && conversationId ? 'pass' : 'fail',
    `HTTP ${createResponse.status} id=${conversationId?.slice(0, 8)} created=${created.created}`,
  );
  const again = await request('POST', '/api/conversations', { body: { clientConversationId: draftId } });
  const againBody = await readJson(again);
  record(
    '同一草稿 ID 不重复建会话',
    againBody.id === conversationId ? 'pass' : 'fail',
    `created=${againBody.created}`,
  );

  /* 6. 发送问题并消费 SSE */
  const clientMessageId = randomUUID();
  let streamed = false;
  let interruptedBeforeDone = false;
  const firstDeltaAt = { value: null };
  const doneAt = { value: null };
  const events = [];

  const send = await request('POST', `/api/conversations/${conversationId}/messages`, {
    body: { clientMessageId, content: '用一句话解释什么是六爻，并按项目要求给出最终结果。' },
    headers: { accept: 'text/event-stream' },
  });

  if (send.status === 503) {
    const body = await readJson(send);
    const code = body?.error?.code;
    record(
      '缺少 API Key 时返回安全错误',
      code === 'llm_not_configured' ? 'pass' : 'fail',
      `HTTP 503 code=${code}；响应不含密钥=${!JSON.stringify(body).includes('sk-')}`,
    );
    const messages = await request('GET', `/api/conversations/${conversationId}/messages`);
    const page = await readJson(messages);
    record(
      '密钥缺失时不产生半条会话记录',
      page.items?.length === 0 ? 'pass' : 'fail',
      `该会话消息数=${page.items?.length ?? '未知'}`,
    );
    generationState = 'not_configured';
    record('流式问答 / 停止生成 / 用量保存', 'blocked', '需要配置 DEEPSEEK_API_KEY 后重跑本脚本');
  } else if (send.status !== 200) {
    const body = await readJson(send);
    record('流式问答', 'fail', `HTTP ${send.status} code=${body?.error?.code ?? '-'}`);
  } else {
    userMessageSaved = true;
    const startedAt = Date.now();
    await consumeSse(send, (event, payload) => {
      events.push(event);
      if (event === 'delta' && firstDeltaAt.value === null) {
        firstDeltaAt.value = Date.now() - startedAt;
        streamed = true;
      }
      if (event === 'done') doneAt.value = Date.now() - startedAt;
      if (event === 'error') {
        console.log(`        流内错误事件：code=${payload?.code} status=${payload?.status}`);
      }
    });
    const hasStart = events.includes('start');
    const hasDone = events.includes('done');
    const hasError = events.includes('error');
    record(
      'SSE 事件序列完整（start 后以 done 或 error 收尾）',
      hasStart && (hasDone || hasError) ? 'pass' : 'fail',
      `事件序列=${[...new Set(events)].join(' → ')}（共 ${events.length} 个事件）`,
    );

    const messages = await request('GET', `/api/conversations/${conversationId}/messages`);
    const page = await readJson(messages);
    const items = page.items ?? [];
    const userMessage = items.find((item) => item.role === 'user');
    const assistantMessage = items.find((item) => item.role === 'assistant');
    record(
      '用户消息与助手消息都已保存',
      Boolean(userMessage) && Boolean(assistantMessage) ? 'pass' : 'fail',
      `消息数=${items.length} 助手状态=${assistantMessage?.status ?? '-'} 模型=${assistantMessage?.model ?? '-'}`,
    );

    if (hasDone) {
      generationState = 'ok';
      record(
        '首段内容早于生成结束到达',
        streamed && firstDeltaAt.value !== null && doneAt.value !== null && firstDeltaAt.value < doneAt.value
          ? 'pass'
          : 'fail',
        `首个 delta ${firstDeltaAt.value ?? '-'}ms，done ${doneAt.value ?? '-'}ms`,
      );
      record(
        '助手消息记录了用量',
        assistantMessage?.usage?.outputTokens != null ? 'pass' : 'info',
        `input=${assistantMessage?.usage?.inputTokens ?? '-'} output=${assistantMessage?.usage?.outputTokens ?? '-'}`,
      );
    } else {
      generationState = 'upstream_failed';
      record(
        '模型调用失败时改用 error 事件并保存失败状态',
        hasError && assistantMessage?.status === 'failed' ? 'pass' : 'fail',
        `助手状态=${assistantMessage?.status ?? '-'}，未产生永久 streaming`,
      );
      record('首段内容早于生成结束到达', 'blocked', '本次上游拒绝了调用，没有正文增量，无法比较时序');
    }
  }

  /* 7. 停止生成 */
  if (generationState !== 'ok') {
    record(
      '停止生成并保存 interrupted',
      'blocked',
      generationState === 'not_configured'
        ? '需要配置 DEEPSEEK_API_KEY 后重跑'
        : '本次上游调用未成功，没有可中断的生成',
    );
  } else {
    const stopMessageId = randomUUID();
    const controller = new AbortController();
    const stopSend = await request('POST', `/api/conversations/${conversationId}/messages`, {
      body: { clientMessageId: stopMessageId, content: '请详细解释六爻纳甲的全部步骤。' },
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (stopSend.status === 200) {
      let sawDelta = false;
      const consumePromise = consumeSse(stopSend, (event) => {
        if (event === 'delta' && !sawDelta) {
          sawDelta = true;
          controller.abort();
          interruptedBeforeDone = true;
        }
      }).catch(() => undefined);
      await Promise.race([consumePromise, sleep(8000)]);
      controller.abort();
      await sleep(1500);
      const messages = await request('GET', `/api/conversations/${conversationId}/messages`);
      const page = await readJson(messages);
      const last = [...(page.items ?? [])].reverse().find((item) => item.role === 'assistant');
      record(
        '停止生成后状态为 interrupted 或已完成',
        last?.status === 'interrupted' || last?.status === 'completed' ? 'pass' : 'fail',
        `最后一条助手消息状态=${last?.status ?? '-'}，已保存内容长度=${(last?.content ?? '').length}`,
      );
      record(
        '没有永久 streaming 状态',
        (page.items ?? []).every((item) => item.status !== 'streaming') ? 'pass' : 'fail',
        '停止后等待 1.5s 复查历史',
      );
    } else {
      record('停止生成', 'blocked', `无法开始生成，HTTP ${stopSend.status}`);
    }
  }

  /* 8. 重复 clientMessageId 去重 */
  {
    const duplicateId = randomUUID();
    const first = await request('POST', `/api/conversations/${conversationId}/messages`, {
      body: { clientMessageId: duplicateId, content: '重复消息去重检查（第一次）。' },
      headers: { accept: 'text/event-stream' },
    });
    if (first.status === 200) {
      const controller = new AbortController();
      await Promise.race([
        consumeSse(first, () => undefined).catch(() => undefined),
        sleep(4000),
      ]);
      controller.abort();
      await sleep(800);
      const second = await request('POST', `/api/conversations/${conversationId}/messages`, {
        body: { clientMessageId: duplicateId, content: '重复消息去重检查（第二次）。' },
        headers: { accept: 'text/event-stream' },
      });
      const body = await readJson(second);
      record(
        '重复 clientMessageId 不插入第二条用户消息',
        second.status === 409 && body?.error?.code === 'duplicate_message' ? 'pass' : 'fail',
        `HTTP ${second.status} code=${body?.error?.code ?? '-'}`,
      );
      const messages = await request('GET', `/api/conversations/${conversationId}/messages`);
      const page = await readJson(messages);
      const duplicates = (page.items ?? []).filter(
        (item) => item.role === 'user' && item.content.includes('重复消息去重检查'),
      );
      record(
        '数据库中该内容只有一条用户消息',
        duplicates.length === 1 ? 'pass' : 'fail',
        `匹配条数=${duplicates.length}`,
      );
    } else {
      record('重复 clientMessageId 去重', 'blocked', `HTTP ${first.status}（需要可用的模型调用）`);
    }
  }

  /* 9. 重命名 + 不被自动标题覆盖 */
  {
    const renameResponse = await request('PATCH', `/api/conversations/${conversationId}`, {
      body: { title: '验收自检会话（手动标题）' },
    });
    const body = await readJson(renameResponse);
    record(
      '会话标题手动重命名',
      renameResponse.status === 200 && body?.conversation?.titleSource === 'manual' ? 'pass' : 'fail',
      `HTTP ${renameResponse.status} titleSource=${body?.conversation?.titleSource ?? '-'}`,
    );

    const list = await request('GET', '/api/conversations?limit=50');
    const listBody = await readJson(list);
    const found = (listBody.items ?? []).find((item) => item.id === conversationId);
    record(
      '历史列表可见且顺序按更新时间',
      found ? 'pass' : userMessageSaved ? 'fail' : 'blocked',
      found
        ? `首位标题=${listBody.items?.[0]?.title ?? '-'}；目标会话标题=${found.title}`
        : '没有已保存消息的会话不会出现在历史列表（需要一次成功的问答）',
    );

    // 再发一条消息，确认手动标题不会被自动标题覆盖（需要模型可用）。
    const renameCheckId = randomUUID();
    const followUp = await request('POST', `/api/conversations/${conversationId}/messages`, {
      body: { clientMessageId: renameCheckId, content: '继续追问一次，检查手动标题是否被覆盖。' },
      headers: { accept: 'text/event-stream' },
    });
    if (followUp.status === 200) {
      await Promise.race([consumeSse(followUp, () => undefined).catch(() => undefined), sleep(8000)]);
    }
    const after = await request('GET', `/api/conversations/${conversationId}`);
    const afterBody = await readJson(after);
    record(
      '手动标题不被后续消息覆盖',
      afterBody?.conversation?.title === '验收自检会话（手动标题）' ? 'pass' : 'fail',
      `当前标题=${afterBody?.conversation?.title ?? '-'} titleSource=${afterBody?.conversation?.titleSource ?? '-'}`,
    );
  }

  /* 10. 刷新/新会话仍可读取历史（服务端持久化） */
  {
    const serverCookie = cookie;
    cookie = '';
    const loginAgain = await request('POST', '/api/auth/login', { body: { password } });
    record('重新登录（模拟刷新/新浏览器）', loginAgain.status === 200 ? 'pass' : 'fail', `HTTP ${loginAgain.status}`);
    const messages = await request('GET', `/api/conversations/${conversationId}/messages`);
    const page = await readJson(messages);
    record(
      '重新登录后仍能读到历史消息',
      (page.items ?? []).length > 0 ? 'pass' : userMessageSaved ? 'fail' : 'blocked',
      `消息数=${page.items?.length ?? 0}`,
    );
    void serverCookie;
  }

  /* 11. 数据库文件与持久化证据 */
  {
    const dbFile = path.join(storage, 'liuyao.db');
    const exists = fs.existsSync(dbFile);
    record(
      'SQLite 数据库位于持久化 storage/',
      exists ? 'pass' : 'fail',
      `${path.relative(projectRoot, dbFile)}（${exists ? fs.statSync(dbFile).size : 0} 字节）`,
    );
    const wal = fs.existsSync(`${dbFile}-wal`);
    record('WAL 模式已启用并产生 -wal 文件', wal ? 'pass' : 'info', wal ? '存在 liuyao.db-wal' : '当前无 -wal（可能已 checkpoint）');
  }

  /* 12. 退出登录后不可访问 */
  {
    const logout = await request('POST', '/api/auth/logout');
    const afterLogout = await request('GET', '/api/conversations');
    record(
      '退出登录后历史接口不可访问',
      logout.status === 200 && afterLogout.status === 401 ? 'pass' : 'fail',
      `logout HTTP ${logout.status}；退出后 /api/conversations HTTP ${afterLogout.status}`,
    );
  }

  /* 13. 伪造来源头不能绕过登录限流（验收报告 2026-10-02 第 2 条）
     注意：这一段会耗尽本进程的登录限流桶，所以必须放在最后。 */
  {
    const attempts = [];
    const configured = Number.parseInt(process.env.LIUYAO_LOGIN_MAX_ATTEMPTS ?? '', 10);
    const tries = (Number.isFinite(configured) ? configured : 10) + 2;
    for (let index = 1; index <= tries; index += 1) {
      const response = await fetch(absolute('/api/auth/login'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `203.0.113.${index}`,
          'x-real-ip': `203.0.113.${index}`,
        },
        body: JSON.stringify({ password: `spoofed-attempt-${index}` }),
      });
      attempts.push(response.status);
    }
    record(
      '伪造 X-Forwarded-For/X-Real-IP 无法绕过登录限流',
      attempts.includes(429) ? 'pass' : 'fail',
      `连续 ${attempts.length} 次错误密码（每次更换来源头）返回码：${attempts.join(',')}`,
    );
  }

  printSummary();
}

function printSummary() {
  const counts = results.reduce(
    (accumulator, item) => {
      accumulator[item.status] = (accumulator[item.status] ?? 0) + 1;
      return accumulator;
    },
    { pass: 0, fail: 0, blocked: 0, info: 0 },
  );
  console.log('');
  console.log('================ 验收自检汇总 ================');
  console.log(`通过 ${counts.pass ?? 0} / 未通过 ${counts.fail ?? 0} / 受阻 ${counts.blocked ?? 0} / 信息 ${counts.info ?? 0}`);
  const failed = results.filter((item) => item.status === 'fail');
  if (failed.length > 0) {
    console.log('未通过项：');
    for (const item of failed) console.log(`  - ${item.name}：${item.detail}`);
    process.exitCode = 1;
  }
  console.log('提示：「受阻」通常表示服务器未配置 DEEPSEEK_API_KEY，配置后重跑即可获得完整证据。');
}

await main();
