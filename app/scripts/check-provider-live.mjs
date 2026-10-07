#!/usr/bin/env node
/**
 * 真实上游连通性自检（阶段 4 任务书第 8.4 节要求"真实 API 联调记录"）。
 *
 * 用 Next 自己的加载器读取 app/.env.local（与应用进程看到的值一致），然后：
 *   1) 无密钥输出：GET {base}/models 探测 DeepSeek 与千问（**不消耗 token**）；
 *   2) 加 --chat 时：各发一条 max_tokens=1 的最小对话，验证密钥可完成真实推理调用
 *      （会产生极小费用，默认关闭）。
 *
 * 安全：只打印状态码/耗时/错误码，**绝不打印密钥**；网络失败时自动尝试本机代理 127.0.0.1:7897。
 *
 * 用法：
 *   node --import ./scripts/lib/register-ts.mjs scripts/check-provider-live.mjs
 *   node --import ./scripts/lib/register-ts.mjs scripts/check-provider-live.mjs --chat
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const withChat = process.argv.includes('--chat');
const PROXY = process.env.LIUYAO_PROBE_PROXY ?? 'http://127.0.0.1:7897';

// 用 Next 的加载器读 .env.local，保证与应用进程看到的值一致
// （@next/env 是 CJS，ESM 下函数挂在 default 上）
const nextEnvModule = await import('@next/env');
const loadEnvConfig = nextEnvModule.loadEnvConfig ?? nextEnvModule.default?.loadEnvConfig;
if (typeof loadEnvConfig !== 'function') {
  console.error('无法从 @next/env 载入 loadEnvConfig');
  process.exit(2);
}
loadEnvConfig(appDir, false);

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};

const mask = (value) => (typeof value === 'string' && value.length > 8 ? `${value.slice(0, 5)}…(${value.length} 字符)` : '(未配置)');

async function request(baseUrl, apiKey, body, label) {
  const url = `${baseUrl.replace(/\/+$/, '')}${body ? '/chat/completions' : '/models'}`;
  const started = Date.now();
  const attempt = async (useProxy) => {
    const args = ['-sS', '-m', '25', '-o', '-', '-w', '\\n%{http_code}', '-H', `Authorization: Bearer ${apiKey}`, '-H', 'content-type: application/json'];
    if (useProxy) args.push('--proxy', PROXY);
    if (body) args.push('-X', 'POST', '-d', JSON.stringify(body));
    args.push(url);
    // 用 curl 而非 fetch：本机直连可能被限制，curl 可显式走本机代理
    const run = spawnSync('curl.exe', args, { encoding: 'utf8', windowsHide: true });
    const stdout = run.stdout ?? '';
    const split = stdout.lastIndexOf('\n');
    const text = split >= 0 ? stdout.slice(0, split) : stdout;
    const status = Number.parseInt((split >= 0 ? stdout.slice(split + 1) : '').trim(), 10);
    return { status: Number.isFinite(status) ? status : 0, text, stderr: (run.stderr ?? '').trim() };
  };

  let outcome = await attempt(false);
  let via = '直连';
  if (outcome.status === 0) {
    outcome = await attempt(true);
    via = '本机代理';
  }
  const ms = Date.now() - started;
  return { ...outcome, ms, via, label };
}

console.log(`应用目录：${appDir}\n`);

const providers = [
  {
    label: 'DeepSeek（deepseek-flash）',
    baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    model: process.env.LLM_MODEL || 'deepseek-flash',
  },
  {
    label: '千问（阿里云百炼/中转）',
    baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
    model: process.env.QWEN_MODEL || 'qwen3.7-plus',
  },
];

console.log('=== 配置读取（经 Next 加载器，仅显示掩码） ===');
for (const provider of providers) {
  console.log(`  ${provider.label}：base=${provider.baseUrl} key=${mask(provider.apiKey)} model=${provider.model}`);
}

console.log('\n=== 1) 模型清单探测（GET /models，不消耗 token） ===');
for (const provider of providers) {
  if (provider.apiKey === '') {
    record(`${provider.label} 配置`, false, '未配置密钥');
    continue;
  }
  const r = await request(provider.baseUrl, provider.apiKey, null, provider.label);
  const ok = r.status === 200;
  const summary = ok
    ? `${r.via} HTTP 200（${r.ms}ms，返回 ${r.text.length} 字节）`
    : `${r.via} HTTP ${r.status}（${r.ms}ms）${r.stderr ? ' stderr=' + r.stderr.slice(0, 80) : ''} ${r.text.slice(0, 120)}`;
  record(`${provider.label} /models 可达`, ok, summary);
  if (ok) {
    // 顺带确认配置里的 model 名是否真的在清单里（避免"能连通但模型名不对"）
    try {
      const parsed = JSON.parse(r.text);
      const ids = (parsed?.data ?? []).map((item) => item?.id).filter((id) => typeof id === 'string');
      const hit = ids.includes(provider.model);
      const similar = ids.filter((id) => /qwen|deepseek/i.test(id)).slice(0, 6);
      record(
        `${provider.label} 模型名「${provider.model}」在清单中`,
        hit,
        hit ? `共 ${ids.length} 个模型` : `共 ${ids.length} 个模型；相似：${similar.join(', ') || '(无)'}`,
      );
    } catch {
      record(`${provider.label} 模型清单可解析`, false, '返回内容不是 JSON（可能该端点不支持 /models）');
    }
  }
}

if (withChat) {
  console.log('\n=== 2) 最小真实对话（max_tokens=1，会产生极小费用） ===');
  for (const provider of providers) {
    if (provider.apiKey === '') continue;
    const r = await request(provider.baseUrl, provider.apiKey, {
      model: provider.model,
      messages: [{ role: 'user', content: '只回复一个字：好' }],
      max_tokens: 1,
      stream: false,
    }, provider.label);
    const ok = r.status === 200 && /"choices"/.test(r.text);
    record(`${provider.label} 真实对话可完成`, ok, ok ? `${r.via} HTTP 200（${r.ms}ms）` : `${r.via} HTTP ${r.status}：${r.text.slice(0, 200)}`);
  }
} else {
  console.log('\n（未加 --chat：跳过真实对话调用，不产生费用）');
}

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
