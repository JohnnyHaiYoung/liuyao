#!/usr/bin/env node
/**
 * 千问（DashScope 兼容模式）适配器自检（阶段 4 任务书第 5、7.5 节）。
 *
 * 用**本地模拟的 DashScope 形状上游**验证适配器自己的终止/错误/用量解析，
 * 因此不需要真实密钥与网络。真实 API 联调需要密钥，本脚本不冒充已完成。
 *
 * 用法：node --import ./scripts/lib/register-ts.mjs scripts/check-qwen-adapter.mjs
 */
import http from 'node:http';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};

/** 模拟上游：按请求体里的 model 字段选择行为（适配器会把 model 传过来）。 */
const server = http.createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
  });
  request.on('end', () => {
    let model = '';
    try {
      model = JSON.parse(raw).model ?? '';
    } catch {
      model = '';
    }
    const sse = (chunks) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      for (const chunk of chunks) response.write(chunk);
      response.end();
    };
    const delta = (text) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
    const finish = (reason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
    const usageChunk = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 }, model: 'qwen3.7-plus' })}\n\n`;

    switch (model) {
      case 'mode-normal':
        sse([delta('你好'), delta('，这是'), finish('stop'), usageChunk, 'data: [DONE]\n\n']);
        return;
      case 'mode-no-done': // 干净 EOF，但没有 [DONE]
        sse([delta('半截'), finish('stop')]);
        return;
      case 'mode-no-finish': // 有 [DONE]，但没有 finish_reason
        sse([delta('半截'), usageChunk, 'data: [DONE]\n\n']);
        return;
      case 'mode-mid-error': // 流中途报错
        sse([delta('先给一点'), `data: ${JSON.stringify({ code: 'InvalidApiKey', message: 'mid-stream error' })}\n\n`]);
        return;
      case 'mode-bad-json':
        sse([delta('ok'), 'data: {not json}\n\n', 'data: [DONE]\n\n']);
        return;
      case 'mode-unauthorized':
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'InvalidApiKey', message: 'Invalid API-key provided.' } }));
        return;
      case 'mode-arrearage':
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.' }));
        return;
      case 'mode-slow': // 用于客户端中断
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.write(delta('慢慢说'));
        return; // 不结束，等客户端 abort
      default:
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'BadRequest', message: `未知模式 ${model}` } }));
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

// 未配置密钥的情形
delete process.env.QWEN_API_KEY;
delete process.env.DASHSCOPE_API_KEY;
const { QwenProvider } = await import('../src/server/llm/qwen.ts');
const unconfigured = new QwenProvider();
check('未配置密钥时 listModels() 为空（不可被选择）', unconfigured.listModels().length === 0, JSON.stringify(unconfigured.listModels()));
{
  const result = await unconfigured.streamChat({ model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal }, { onDelta: () => {} });
  check('未配置密钥时调用返回 llm_not_configured', result.errorCode === 'llm_not_configured' && result.status === 'failed', String(result.errorCode));
}

// 配置密钥后
process.env.QWEN_API_KEY = 'sk-mock';
process.env.QWEN_BASE_URL = baseUrl;
const provider = new QwenProvider();
check('配置密钥后列出 qwen3.7-plus', provider.listModels().join(',') === 'qwen3.7-plus', provider.listModels().join(','));
check('适配器 id/label/defaultModel 正确', provider.id === 'qwen' && provider.defaultModel === 'qwen3.7-plus', `${provider.id}/${provider.defaultModel}`);

const run = async (mode, { abortAfterMs = null } = {}) => {
  const texts = [];
  const usages = [];
  const controller = new AbortController();
  if (abortAfterMs !== null) setTimeout(() => controller.abort(), abortAfterMs);
  const result = await provider.streamChat(
    { model: mode, messages: [{ role: 'user', content: '测试' }], signal: controller.signal, maxOutputTokens: 64 },
    { onDelta: (text) => texts.push(text), onUsage: (usage) => usages.push(usage) },
  );
  return { result, text: texts.join(''), usages };
};

console.log('\n=== 正常流 ===');
{
  const { result, text, usages } = await run('mode-normal');
  check('状态为 completed', result.status === 'completed', result.status);
  check('增量按序拼接正确', text === '你好，这是', text);
  check('结束原因为 stop', result.finishReason === 'stop', String(result.finishReason));
  check('用量从上游 usage 解析', result.usage.totalTokens === 30 && result.usage.inputTokens === 21 && result.usage.outputTokens === 9, JSON.stringify(result.usage));
  check('用量回调被触发', usages.length === 1, `${usages.length} 次`);
  check('记录上游实际模型名', result.usedModel === 'qwen3.7-plus', result.usedModel);
}

console.log('\n=== 异常终止（绝不如实报成完成） ===');
{
  const noDone = await run('mode-no-done');
  check('缺少 [DONE] → failed（保留已生成文本）', noDone.result.status === 'failed' && noDone.text === '半截', `${noDone.result.status}/${noDone.text}`);
  const noFinish = await run('mode-no-finish');
  check('缺少 finish_reason → failed', noFinish.result.status === 'failed', `${noFinish.result.status} detail=${noFinish.result.errorDetail ?? ''}`);
  const midError = await run('mode-mid-error');
  check('流中途错误事件 → failed', midError.result.status === 'failed' && midError.result.errorCode !== null, `${midError.result.status}/${midError.result.errorCode}`);
  const badJson = await run('mode-bad-json');
  check('损坏的数据块 → failed（不静默完成）', badJson.result.status === 'failed', `${badJson.result.status}`);
}

console.log('\n=== HTTP 错误分类 ===');
{
  const unauthorized = await run('mode-unauthorized');
  check('401 → upstream_auth_error', unauthorized.result.errorCode === 'upstream_auth_error', String(unauthorized.result.errorCode));
  const arrearage = await run('mode-arrearage');
  check('400 + Arrearage → 余额不足类错误', arrearage.result.errorCode === 'upstream_insufficient_balance', String(arrearage.result.errorCode));
}

console.log('\n=== 客户端中断 ===');
{
  const slow = await run('mode-slow', { abortAfterMs: 150 });
  check('浏览器断开 → interrupted（不是 failed/completed）', slow.result.status === 'interrupted', `${slow.result.status}/${slow.result.errorCode}`);
}

console.log('\n=== 默认模型不受影响 ===');
{
  const llm = await import('../src/server/llm/index.ts');
  check('默认提供方仍是 DeepSeek', llm.getDefaultProvider().id === 'deepseek', llm.getDefaultProvider().id);
  check('默认模型仍是 deepseek-flash', llm.defaultModelId() === 'deepseek-flash', llm.defaultModelId());
  check('已配置的千问可按模型名解析到', llm.resolveProviderForModel('qwen3.7-plus')?.id === 'qwen', String(llm.resolveProviderForModel('qwen3.7-plus')?.id));
  delete process.env.QWEN_API_KEY;
  const qwenAfter = new QwenProvider();
  check('移除密钥后不再可选（服务端会拒绝）', qwenAfter.listModels().length === 0, JSON.stringify(qwenAfter.listModels()));
}

server.close();

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
