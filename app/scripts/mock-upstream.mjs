#!/usr/bin/env node
/**
 * 模拟上游（浏览器级测试专用）：同时扮演 DeepSeek 与千问的 OpenAI 兼容接口。
 *
 * 目的：让浏览器级测试**不接触真实 API**（不花钱、不依赖网络与密钥），同时能区分
 * "这条回复到底走了哪个上游"——每个模型独立计数，测试通过 /__stats 断言。
 *
 * 路由：
 *   POST {任意前缀}/chat/completions  → SSE 流（内容里带模型名）
 *   GET  {任意前缀}/models            → 按前缀返回含 deepseek-flash 或 qwen3.7-plus 的清单
 *   GET  /__stats                     → { calls: { '<model>': n }, paths: [...] }
 *
 * 用法：node scripts/mock-upstream.mjs --port 0   （打印实际端口后保持运行）
 */
import http from 'node:http';

const portArg = process.argv.indexOf('--port');
const requestedPort = portArg >= 0 ? Number(process.argv[portArg + 1]) : 0;

const stats = { calls: {}, paths: [] };

const sseChunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const isQwen = url.pathname.includes('compatible-mode');
  const model = isQwen ? 'qwen3.7-plus' : 'deepseek-flash';

  if (url.pathname === '/__stats') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(stats));
    return;
  }

  if (url.pathname.endsWith('/models')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
    return;
  }

  if (url.pathname.endsWith('/chat/completions') && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      let requestedModel = model;
      let systemContent = '';
      try {
        const parsed = JSON.parse(body);
        requestedModel = parsed.model ?? model;
        // 必须用**解析后**的系统提示做匹配：原始请求体里引号是转义的（sid=\"S1\"），
        // 直接在原始字符串上匹配会永远失败（这正是浏览器测试此前"无依据"的原因）。
        systemContent = (parsed.messages ?? [])
          .filter((message) => message?.role === 'system')
          .map((message) => (typeof message.content === 'string' ? message.content : ''))
          .join('\n');
      } catch {
        /* 保留默认 */
      }
      stats.calls[requestedModel] = (stats.calls[requestedModel] ?? 0) + 1;
      stats.paths.push(url.pathname);
      // 测试替身行为：若服务端在系统提示里放了编号证据，就引用其中的首个真实编号，
      // 这样"模型确实引用 → 页面显示依据 → 历史保存快照"这条链路才可被浏览器级验证。
      const firstSid = /<wiki-evidence[^>]*\bsid="(S\d+)"/.exec(systemContent)?.[1] ?? null;
      // 自证：记录本次请求里到底有没有编号证据（浏览器级测试据此判断"服务端是否送出了证据"）
      stats.lastSid = firstSid;
      stats.sawWikiEvidence = firstSid !== null;
      stats.lastBodyLength = body.length;
      stats.systemPromptLength = systemContent.length;
      const citation = firstSid ? `按 ${firstSid} 的说法，` : '';
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const text = `（模拟上游回复）本次由 ${requestedModel} 生成。${citation}最终结果：模拟上游完成。`;
      for (const char of Array.from(text)) {
        response.write(sseChunk({ choices: [{ index: 0, delta: { content: char }, finish_reason: null }] }));
      }
      response.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: text.length, total_tokens: 12 + text.length } }));
      response.write('data: [DONE]\n\n');
      response.end();
    });
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: `mock upstream: 未处理 ${request.method} ${url.pathname}` } }));
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  // 供调用方读取（Playwright globalSetup 会解析这一行）
  console.log(`MOCK_UPSTREAM_PORT=${port}`);
});
