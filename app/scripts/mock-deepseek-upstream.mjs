#!/usr/bin/env node
/**
 * 可控模拟上游（DeepSeek Chat Completions 兼容），仅用于本地验收与回归测试。
 *
 * 目的：在没有真实 API Key、也不依赖第三方服务的情况下，验证我们自己的适配层在
 * 各种上游行为下的终止语义是否正确——特别是「提前 EOF / 连接被重置 / 上游报错」
 * 绝不能被记录成 completed（见 docs/phase1_acceptance_2026-10-02.md 第 1 条）。
 *
 * 用法：
 *   node scripts/mock-deepseek-upstream.mjs --port 3211 [--mode normal]
 * 运行时切换模式（测试脚本用）：
 *   GET  http://127.0.0.1:3211/__control        -> {mode}
 *   POST http://127.0.0.1:3211/__control {"mode":"eof"}
 *
 * 模式：
 *   normal  正常结束：正文增量 + finish_reason=stop + data: [DONE]
 *   length  达到长度上限：正文增量 + finish_reason=length + data: [DONE]
 *   eof     干净 EOF：有正文，但没有 finish_reason，也没有 [DONE]
 *   reset   连接被重置：有正文后直接销毁 socket
 *   http500 上游 5xx
 *   http401 上游 401（密钥无效）
 *   slow    慢速吐字（用于测试“停止生成”→ interrupted）
 *   empty   [DONE] 之前没有任何正文
 *
 * 它不会访问网络，也不产生任何费用；模型名固定为 deepseek-flash 以便与应用一致，
 * 但响应里带 `x-mock-upstream: <mode>` 头，便于确认流量确实走的是本模拟器。
 */

import http from 'node:http';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number.parseInt(argValue('--port', '3211'), 10);
let mode = argValue('--mode', 'normal');

const CONTENT_CHUNKS = ['这是', '模拟上游', '返回的', '正文', '。'];

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunkFrame(delta, finishReason = null) {
  return sseChunk({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-flash',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function finalFrame(finishReason) {
  return sseChunk({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-flash',
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(text);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

  if (url.pathname === '/__control') {
    if (request.method === 'POST') {
      let raw = '';
      for await (const part of request) raw += part;
      try {
        const parsed = JSON.parse(raw || '{}');
        if (typeof parsed.mode === 'string') mode = parsed.mode;
      } catch {
        return sendJson(response, 400, { error: 'invalid json' });
      }
    }
    return sendJson(response, 200, { mode });
  }

  if (!url.pathname.endsWith('/chat/completions')) {
    return sendJson(response, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  }

  if (mode === 'http401') {
    return sendJson(response, 401, {
      error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error', code: 'invalid_request_error' },
    });
  }
  if (mode === 'http500') {
    return sendJson(response, 500, {
      error: { message: 'internal server error (mock)', type: 'server_error', code: 'server_error' },
    });
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'x-mock-upstream': mode,
  });

  const write = (frame) => response.write(frame);

  if (mode === 'empty') {
    write(finalFrame('stop'));
    write('data: [DONE]\n\n');
    return response.end();
  }

  if (mode === 'slow') {
    let index = 0;
    const timer = setInterval(() => {
      if (index >= 40) {
        clearInterval(timer);
        write(finalFrame('stop'));
        write('data: [DONE]\n\n');
        return response.end();
      }
      write(chunkFrame({ content: `第${index + 1}段 ` }));
      index += 1;
    }, 200);
    request.on('close', () => clearInterval(timer));
    return undefined;
  }

  // 先发角色帧与正文增量（与真实上游一致）。
  write(chunkFrame({ role: 'assistant', content: '' }));
  for (const piece of CONTENT_CHUNKS) {
    write(chunkFrame({ content: piece }));
  }

  if (mode === 'eof') {
    // 干净 EOF：正文之后直接结束，既没有 finish_reason，也没有 [DONE]。
    return response.end();
  }

  if (mode === 'reset') {
    // 连接被重置：先让已写出的正文真正到达客户端，再销毁 socket。
    setTimeout(() => response.destroy(), 80);
    return undefined;
  }

  write(finalFrame(mode === 'length' ? 'length' : 'stop'));
  write('data: [DONE]\n\n');
  return response.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock deepseek upstream on http://127.0.0.1:${port} (mode=${mode})`);
});
