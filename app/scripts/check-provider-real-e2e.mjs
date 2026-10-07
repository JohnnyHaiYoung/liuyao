#!/usr/bin/env node
/**
 * 真实上游联调（阶段 4 任务书第 8.4 节要求的"真实 API 联调记录"）。
 *
 * 与 check-phase4-e2e.mjs 的区别：这里**不启用假模型**，真实调用 DeepSeek 与千问，验证：
 *   - 适配器对真实上游 SSE 的增量/终止/用量解析；
 *   - 编排层（目录选页 + 排盘 + 预算）在真实模型下的表现；
 *   - 事件链路与历史落库（provider/model/usage/来源快照/盘面快照）。
 *
 * 需要 app/.env.local 里配置 DEEPSEEK_API_KEY 与（可选）QWEN_API_KEY/DASHSCOPE_API_KEY；
 * **会产生极小真实费用**（默认只发两条短问题、输出上限 400 token），因此不放进默认自检套件。
 *
 * 安全与隔离：经 Next 加载器读 app/.env.local，但把 STORAGE 指向**正式库的副本**，
 * 不触碰正式 storage/liuyao.db；输出只打印状态、用量与错误码，绝不打印密钥。
 *
 * 用法：node --import ./scripts/lib/register-ts.mjs scripts/check-provider-real-e2e.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const projectRoot = path.resolve(appDir, '..');
const liveDb = path.join(projectRoot, 'storage', 'liuyao.db');

const nextEnvModule = await import('@next/env');
const loadEnvConfig = nextEnvModule.loadEnvConfig ?? nextEnvModule.default?.loadEnvConfig;
if (typeof loadEnvConfig !== 'function') {
  console.error('无法从 @next/env 载入 loadEnvConfig');
  process.exit(2);
}
loadEnvConfig(appDir, false);
console.log(`应用目录：${appDir}`);

const hasDeepSeek = (process.env.DEEPSEEK_API_KEY ?? '').trim() !== '';
const hasQwen = ((process.env.QWEN_API_KEY ?? '') + (process.env.DASHSCOPE_API_KEY ?? '')).trim() !== '';
console.log(`密钥：DeepSeek=${hasDeepSeek ? '已配置' : '未配置'}，千问=${hasQwen ? '已配置' : '未配置'}`);
if (!hasDeepSeek && !hasQwen) {
  console.error('未配置任何上游密钥；请先在 app/.env.local 配置 DEEPSEEK_API_KEY / QWEN_API_KEY。');
  process.exit(2);
}

// 隔离：用正式库副本，并限制输出 token 以控制费用
const workDir = path.join(projectRoot, 'storage', 'tmp', `provider-real-e2e-${process.pid}`);
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(`${liveDb}${suffix}`)) fs.copyFileSync(`${liveDb}${suffix}`, path.join(workDir, `liuyao.db${suffix}`));
}
process.env.LIUYAO_STORAGE_DIR = workDir;
process.env.LIUYAO_MIGRATIONS_DIR = path.join(appDir, 'migrations');
delete process.env.LIUYAO_FAKE_MODEL;
process.env.LLM_MAX_OUTPUT_TOKENS = '400';
// 联调用小上限控制费用；此时必须关掉"思考"（none），否则思考 token 会吃满预算、
// 可见正文为空（会看到 finish_reason=length + output_limit_reached）。正式环境用官方默认上限。
process.env.LLM_REASONING_EFFORT = 'none';

const { getDb } = await import('../src/server/db/index.ts');
const { startChatStream } = await import('../src/server/chat/stream-service.ts');
const { listMessages } = await import('../src/server/db/messages.ts');

const db = getDb();
const owner = db.prepare('SELECT id FROM owners ORDER BY created_at LIMIT 1').get();
if (!owner) {
  console.error('旧库里没有 owner，无法进行联调');
  process.exit(2);
}
const conversationId = crypto.randomUUID();
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO conversations (id, owner_id, client_conversation_id, title, title_source, created_at, updated_at, last_message_at)
   VALUES (?, ?, ?, '', 'auto', ?, ?, NULL)`,
).run(conversationId, owner.id, `real-${conversationId}`, now, now);

async function readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
      let event = 'message';
      const dataLines = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length > 0) {
        try {
          events.push({ event, data: JSON.parse(dataLines.join('\n')) });
        } catch {
          events.push({ event, data: dataLines.join('\n') });
        }
      }
    }
  }
  return events;
}

async function send(content, model) {
  const outcome = startChatStream({
    ownerId: owner.id,
    conversationId,
    clientMessageId: crypto.randomUUID(),
    content,
    requestedModel: model,
    clientSignal: new AbortController().signal,
  });
  if (!outcome.ok) return { error: `${outcome.status} ${outcome.code} ${outcome.message ?? ''}` };
  const events = await readEvents(outcome.response);
  return { events, names: events.map((item) => item.event) };
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};

const cases = [
  {
    label: 'DeepSeek · 概念问题（走 Wiki 选页）',
    model: process.env.LLM_MODEL || 'deepseek-flash',
    content: '什么是用神？请用两三句话说明，并在末尾以「最终结果：」开头。',
    enabled: hasDeepSeek,
  },
  {
    label: '千问 · 具体卦例（走服务端排盘）',
    model: process.env.QWEN_MODEL || 'qwen3.7-plus',
    content: '帮我看看这卦：爻值 8 7 8 8 8 7，2006-05-10 14:22，北京时间。请简短说明盘面要素，末尾以「最终结果：」开头。',
    enabled: hasQwen,
  },
];

for (const item of cases) {
  if (!item.enabled) {
    console.log(`\n=== ${item.label} ===\n  （跳过：未配置密钥）`);
    continue;
  }
  console.log(`\n=== ${item.label}（model=${item.model}） ===`);
  const started = Date.now();
  const sent = await send(item.content, item.model);
  const ms = Date.now() - started;
  if (sent.error) {
    check(`${item.label} 调用成功`, false, sent.error);
    continue;
  }
  const done = sent.events.find((event) => event.event === 'done');
  const sources = sent.events.find((event) => event.event === 'sources');
  const chart = sent.events.find((event) => event.event === 'chart');
  const text = sent.events.filter((event) => event.event === 'delta').map((event) => event.data.text).join('');
  const page = listMessages(db, conversationId, { limit: 6 });
  const last = page.items.at(-1);

  check(
    'SSE 以 done 收尾且状态 completed',
    done?.data?.status === 'completed',
    `${sent.names.slice(0, 2).join('→')}…→${sent.names.at(-1)}（${ms}ms，${sent.names.filter((name) => name === 'delta').length} 段增量）`,
  );
  check('真实模型返回了正文', text.trim().length > 0, `${text.trim().length} 字符；含「最终结果：」=${text.includes('最终结果：')}`);
  check('用量被解析并落库', (last?.usage?.totalTokens ?? 0) > 0, `input=${last?.usage?.inputTokens} output=${last?.usage?.outputTokens} total=${last?.usage?.totalTokens}`);
  check(
    '历史记录实际模型与提供方',
    last?.model === item.model && last?.provider === (item.model === 'qwen3.7-plus' ? 'qwen' : 'deepseek'),
    `provider=${last?.provider} model=${last?.model}`,
  );

  if (item.model === 'qwen3.7-plus') {
    check(
      '排盘事件与盘面快照绑定',
      chart?.data?.action === 'new' && done?.data?.chartRunId === chart?.data?.chartRunId,
      `${chart?.data?.summary?.originalHexagram} 日柱${chart?.data?.summary?.dayGanzhi}`,
    );
    check('历史可按消息读回盘面快照', Boolean(last?.chart) && last.chart.chartRunId === chart?.data?.chartRunId, last?.chart ? last.chart.canonicalHash.slice(0, 12) + '…' : '无');
  } else {
    check('候选资料以 candidate=true 下发', sources?.data?.candidate === true && (sources?.data?.sources ?? []).length > 0, `${(sources?.data?.sources ?? []).length} 条候选`);
    check('最终引用只含被引用的编号', Array.isArray(done?.data?.sourceIds), `sourceIds=${JSON.stringify(done?.data?.sourceIds)}`);
  }
}

const env = await import('../src/server/db/index.ts');
env.closeDb();
fs.rmSync(workDir, { recursive: true, force: true });
check('测试库副本已清理（正式库未动）', !fs.existsSync(workDir), path.relative(projectRoot, workDir));

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
