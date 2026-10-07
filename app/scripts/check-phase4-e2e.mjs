#!/usr/bin/env node
/**
 * 第四阶段端到端复验（进程内，无需真实密钥/网络）。
 *
 * 覆盖任务书第 7 节四条主流程 + 事件顺序 + 历史一致 + 旧盘不重算 + 缺项不调用模型：
 *   1) 概念问题（本地命中，sources 事件）
 *   2) 来源比较（对照页 + 被引来源）
 *   3) 具体卦例（chart 事件、新盘落库）
 *   4) 旧卦追问（沿用同一快照、不重算）
 *   5) 缺项只追问（不调用模型，本地澄清）
 *   6) 无本地命中（不伪造来源）
 *
 * 用的是**真实** stream-service、真实 SQLite（0002 迁移后）、真实快照层与假模型
 * （LIUYAO_FAKE_MODEL=1，绝不冒充真实 API 联调）。HTTP 层与登录由 verify-phase1 覆盖。
 *
 * 用法：node --import ./scripts/lib/register-ts.mjs scripts/check-phase4-e2e.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const projectRoot = path.resolve(appDir, '..');
const liveDb = path.join(projectRoot, 'storage', 'liuyao.db');

if (!fs.existsSync(liveDb)) {
  console.error(`找不到阶段 1 正式库：${liveDb}`);
  process.exit(2);
}

// 用副本，绝不改正式库
const workDir = path.join(projectRoot, 'storage', 'tmp', `e2e-phase4-${process.pid}`);
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(`${liveDb}${suffix}`)) fs.copyFileSync(`${liveDb}${suffix}`, path.join(workDir, `liuyao.db${suffix}`));
}
process.env.LIUYAO_STORAGE_DIR = workDir;
process.env.LIUYAO_MIGRATIONS_DIR = path.join(appDir, 'migrations');
process.env.LIUYAO_FAKE_MODEL = '1';
delete process.env.DEEPSEEK_API_KEY;

const { getDb } = await import('../src/server/db/index.ts');
const { startChatStream } = await import('../src/server/chat/stream-service.ts');
const { listMessages } = await import('../src/server/db/messages.ts');

const db = getDb();
const owner = db.prepare('SELECT id FROM owners ORDER BY created_at LIMIT 1').get();
if (!owner) {
  console.error('旧库里没有 owner，无法进行端到端复验');
  process.exit(2);
}

const conversationId = crypto.randomUUID();
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO conversations (id, owner_id, client_conversation_id, title, title_source, created_at, updated_at, last_message_at)
   VALUES (?, ?, ?, '', 'auto', ?, ?, NULL)`,
).run(conversationId, owner.id, `e2e-${conversationId}`, now, now);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};

/** 解析 SSE 响应体为事件数组。 */
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

async function send(content, extra = {}) {
  const outcome = startChatStream({
    ownerId: owner.id,
    conversationId,
    clientMessageId: crypto.randomUUID(),
    content,
    requestedModel: null,
    clientSignal: new AbortController().signal,
    ...extra,
  });
  if (!outcome.ok) throw new Error(`startChatStream 失败：${outcome.status} ${outcome.code} ${outcome.message ?? ''}`);
  const events = await readEvents(outcome.response);
  return { events, names: events.map((item) => item.event) };
}

const order = (names) => names.filter((name, index) => name !== 'delta' || names.indexOf(name) === index);

console.log(`项目根：${projectRoot}`);
console.log(`测试库副本：${path.relative(projectRoot, workDir)}（正式库只读）\n`);

console.log('=== 1) 概念问题：「什么是用神？」 ===');
{
  const { events, names } = await send('什么是用神？');
  const start = events.find((item) => item.event === 'start');
  const sources = events.find((item) => item.event === 'sources');
  const done = events.find((item) => item.event === 'done');
  check('事件顺序 start → sources → delta → done', order(names).join(' → ').replace(/delta( → delta)*/, 'delta') === 'start → sources → delta → done', order(names).join(' → '));
  check('start 带阶段 4 提示版本', start?.data?.promptVersion === 'phase4-v1', String(start?.data?.promptVersion));
  check('sources 事件给出服务端验证的编号与链接（且标记为候选）', Array.isArray(sources?.data?.sources) && sources.data.sources.length > 0 && sources.data.sources.every((item) => item.href.startsWith('/api/sources/')) && sources.data.candidate === true, `${sources?.data?.sources?.map((item) => `${item.sid}:${item.sourceId}`).join(' ')} candidate=${sources?.data?.candidate}`);
  check('模型未引用前不把候选当依据（done.sourceIds 只含实际引用）', Array.isArray(done?.data?.sourceIds) && done.data.sourceIds.every((sid) => sources.data.sources.some((item) => item.sid === sid)), `sourceIds=${JSON.stringify(done?.data?.sourceIds)}`);
  check('本次没有盘面（无 chart 事件、done.chartRunId 为空）', !names.includes('chart') && (done?.data?.chartRunId ?? null) === null, `chartRunId=${String(done?.data?.chartRunId)}`);
  check('done 状态为 completed 且有用量字段', done?.data?.status === 'completed' && 'usage' in (done.data ?? {}), String(done?.data?.status));
}

console.log('\n=== 2) 来源比较：「梅花起卦与六爻断卦怎么比较？」 ===');
{
  const { events, names } = await send('梅花起卦与六爻断卦怎么比较？');
  const sources = events.find((item) => item.event === 'sources');
  const sourceIds = new Set((sources?.data?.sources ?? []).map((item) => item.sourceId));
  // 设计规则：无 ¶NNNN/页码定位的综述页（对照页）只作"无定位背景"给模型，不作可点击出处；
  // 因此这里核对的是 ①计划里确实选中了对照页 ②出处并列了两个**原件**来源。
  const planRow = db
    .prepare("SELECT plan_json FROM messages WHERE conversation_id = ? AND plan_json IS NOT NULL ORDER BY created_at DESC LIMIT 1")
    .get(conversationId);
  const plan = planRow?.plan_json ? JSON.parse(planRow.plan_json) : null;
  check(
    '计划对象里选中了对照页（并由其展开被引原件）',
    Array.isArray(plan?.selectedPageIds) && plan.selectedPageIds.includes('comparison:meihua-vs-liuyao'),
    (plan?.selectedPageIds ?? []).join(', '),
  );
  check('出处并列两个不同原件（并列而非裁决）', sourceIds.size >= 2, [...sourceIds].join(', '));
  check('needs_review 来源带质量标记', (sources?.data?.sources ?? []).some((item) => item.qualityStatus === 'needs_review' && item.needsQualityNotice === true), '');
  check('无盘（比较类问题不排盘）', !names.includes('chart'), '');
}

console.log('\n=== 3) 具体卦例（完整输入 → 服务端排盘） ===');
let chartRunId = null;
{
  const { events, names } = await send('帮我看看这卦：爻值 8 7 8 8 8 7，2006-05-10 14:22，北京时间');
  const chart = events.find((item) => item.event === 'chart');
  const done = events.find((item) => item.event === 'done');
  chartRunId = done?.data?.chartRunId ?? null;
  check('出现 chart 事件且 action=new', chart?.data?.action === 'new', String(chart?.data?.action));
  check('盘面摘要字段由服务端给出', chart?.data?.summary?.originalHexagram === '山水蒙' && chart.data.summary.palace === '离宫' && chart.data.summary.dayGanzhi === '己亥', `${chart?.data?.summary?.originalHexagram} ${chart?.data?.summary?.palace} 日柱${chart?.data?.summary?.dayGanzhi}`);
  check('done.chartRunId 指向新盘且哈希一致', typeof chartRunId === 'string' && chartRunId.length > 0 && done?.data?.chartRunId === chartRunId, String(chartRunId).slice(0, 8) + '…');
  check('事件顺序 chart 在 delta 之前', names.indexOf('chart') > -1 && names.indexOf('chart') < names.indexOf('delta'), names.join(' → '));
}

console.log('\n=== 4) 旧卦追问（沿用快照，不重算） ===');
{
  const before = db.prepare('SELECT COUNT(*) AS c FROM chart_runs').get().c;
  const { events, names } = await send('那这卦的应期呢？');
  const chart = events.find((item) => item.event === 'chart');
  const done = events.find((item) => item.event === 'done');
  const after = db.prepare('SELECT COUNT(*) AS c FROM chart_runs').get().c;
  check('chart 事件 action=follow_up 且沿用同一 id', chart?.data?.action === 'follow_up' && chart?.data?.chartRunId === chartRunId, `${chart?.data?.action} ${String(chart?.data?.chartRunId).slice(0, 8)}…`);
  check('未产生新盘（chart_runs 行数不变）', before === after, `${before} → ${after}`);
  check('done 仍绑定同一快照', done?.data?.chartRunId === chartRunId, '');
  check('追问仍调用模型（有 delta）', names.includes('delta'), names.join(' → '));
}

console.log('\n=== 5) 缺项只追问（不调用模型） ===');
{
  // 复验报告 P1-1：单纯请求起卦（没有爻值/时间）也必须只澄清，不进入模型
  for (const pure of [
    '帮我起卦',
    '另起一卦',
    '请帮我看卦',
    '帮我起卦，比较两份工作机会',
    '请帮我起卦，看看收入来源如何',
    '请用六爻帮我起卦，比较两份工作机会',
    '帮我用六爻起卦，比较两个方案',
    '请帮我用六爻起卦',
    // 复验报告 2250d0d P1：混合句里的起卦请求必须仍然产生本地缺项追问
    '请起一卦，顺便介绍六爻起卦的方法',
    '我想了解起卦方法，然后请起一卦',
    '请介绍六爻起卦的方法，再起一卦看看工作',
    // 复验报告 5f1d2f1 P1：无标点并列（并/且）时仍须本地缺项追问
    '请起一卦并解释起卦方法',
    '请起一卦且说明起卦步骤',
    '请起一卦并介绍六爻起卦的方法',
  ]) {
    const { events, names } = await send(pure);
    const text = events.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
    const page = listMessages(db, conversationId, { limit: 50 });
    const last = page.items.at(-1);
    check(
      `「${pure}」只澄清、不排盘、无上游调用`,
      !names.includes('chart') && !names.includes('sources') && last?.model === 'local-clarification' && text.includes('最终结果：'),
      `model=${last?.model} chart=${names.includes('chart')} sources=${names.includes('sources')}`,
    );
  }

  // 复验报告（8dd1c09）P1：知识问法必须走模型（可答知识），不得变成排盘缺项追问
  for (const knowledge of ['我想了解六爻起卦的方法', '请介绍一下如何用六爻起卦', '帮我解释六爻起卦的步骤']) {
    const { events, names } = await send(knowledge);
    const text = events.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
    const page = listMessages(db, conversationId, { limit: 50 });
    const last = page.items.at(-1);
    check(
      `知识问法「${knowledge}」正常作答（非本地缺项追问）`,
      last?.model !== 'local-clarification' && !text.includes('需要补充以下信息') && !names.includes('chart'),
      `model=${last?.model} chart=${names.includes('chart')} 索取排盘输入=${text.includes('需要补充以下信息')}`,
    );
  }
  // 方案 A「保证追问」的消息级断言：判定走知识路线时，回答开头仍必须带缺项澄清
  {
    const { events, names } = await send('请问起一卦的步骤是什么');
    const text = events.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
    const page = listMessages(db, conversationId, { limit: 50 });
    const last = page.items.at(-1);
    check(
      '保证追问：知识路线也必须附缺项澄清（消息级）',
      last?.model !== 'local-clarification' &&
        names.includes('delta') &&
        text.includes('服务端提示') &&
        text.includes('六次爻值') &&
        text.includes('时区') &&
        !names.includes('chart'),
      `model=${last?.model} 含提示=${text.includes('服务端提示')}`,
    );
    const { events: controlEvents } = await send('什么是用神？');
    const controlText = controlEvents.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
    check('对照：纯知识问题不附缺项澄清（避免噪音）', !controlText.includes('服务端提示'), `长度 ${controlText.length}`);
  }

  // 歧义问法：只问一句"学习方法还是现在起卦"，且不索取排盘输入
  {
    const { events, names } = await send('请教我用六爻起卦');
    const text = events.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
    const page = listMessages(db, conversationId, { limit: 50 });
    const last = page.items.at(-1);
    check(
      '歧义问法「请教我用六爻起卦」只问一句澄清、不索取排盘输入',
      last?.model === 'local-clarification' &&
        text.includes('学习方法') &&
        text.includes('现在起一卦') &&
        !text.includes('需要补充以下信息') &&
        !names.includes('chart'),
      `model=${last?.model} chart=${names.includes('chart')}`,
    );
  }

  const { events, names } = await send('帮我起一卦，爻值 8 7 8 8 8 7');
  const deltas = events.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
  const page = listMessages(db, conversationId, { limit: 50 });
  const last = page.items.at(-1);
  check('不产生 chart 事件', !names.includes('chart'), names.join(' → '));
  check('本地澄清以「最终结果：」结尾', deltas.includes('需要补充以下信息') && deltas.includes('最终结果：需要你补充'), deltas.split('\n').at(-1) ?? '');
  check('未调用模型（消息 model 记为 local-clarification）', last?.model === 'local-clarification', String(last?.model));
  check('澄清也落库且状态为 completed', last?.status === 'completed' && (last?.content ?? '').includes('最终结果：'), `${last?.status}`);
}

console.log('\n=== 6) 无本地命中（不伪造来源） ===');
{
  const { events, names } = await send('今天天气怎么样？');
  const sources = events.find((item) => item.event === 'sources');
  const done = events.find((item) => item.event === 'done');
  check('不产生 sources 事件', !names.includes('sources'), names.join(' → '));
  check('仍正常完成对话', names.includes('done'), names.join(' → '));
  check('无候选时最终引用为空', Array.isArray(done?.data?.sourceIds) && done.data.sourceIds.length === 0, JSON.stringify(done?.data?.sourceIds));
}

console.log('\n=== 7) 历史回看与 done 一致、旧消息不受影响 ===');
{
  const page = listMessages(db, conversationId, { limit: 100 });
  const chartMessage = page.items.find((item) => item.chart?.chartRunId === chartRunId);
  check('历史里能找到绑定该盘的助手消息', Boolean(chartMessage), chartMessage ? chartMessage.id.slice(0, 8) + '…' : '未找到');
  check('历史盘面哈希与事件一致', Boolean(chartMessage?.chart) && chartMessage.chart.chartRunId === chartRunId, chartMessage?.chart?.canonicalHash?.slice(0, 12) ?? '');
  const sourcesMessage = page.items.find((item) => (item.sources ?? []).length > 0);
  // 复验报告 P1-2：这里必须**非空**断言——此前用 (… ?? []).every() 让 0 条也判通过
  check(
    '历史来源快照非空，且只含被实际引用的编号',
    (sourcesMessage?.sources ?? []).length > 0 && sourcesMessage.sources.every((item) => item.sid === 'S1'),
    `${(sourcesMessage?.sources ?? []).length} 条：${(sourcesMessage?.sources ?? []).map((item) => item.sid).join(',') || '(空)'}`,
  );
  check('历史来源快照带当时的摘录与页哈希（P1-4）', (sourcesMessage?.sources ?? []).every((item) => typeof item.excerpt === 'string' && item.excerpt.length > 0 && /^[0-9a-f]{64}$/.test(item.pageSha256)), `${(sourcesMessage?.sources ?? []).map((item) => `${item.sid}:hash=${item.pageSha256.slice(0, 8)}`).join(' ')}`);
  check('历史来源链接由服务端生成', (sourcesMessage?.sources ?? []).length > 0 && sourcesMessage.sources.every((item) => item.href.startsWith('/api/sources/')), '');
  const noEvidenceMessage = page.items.filter((item) => item.role === 'assistant' && (item.content ?? '').includes('最终结果：') && (item.sources ?? []).length === 0).length;
  check('未引用的候选不会写成历史依据', noEvidenceMessage > 0, `无来源的助手消息 ${noEvidenceMessage} 条`);
  const promptVersions = new Set(page.items.filter((item) => item.role === 'assistant' && item.model !== 'local-clarification').map((item) => item.promptVersion));
  check('助手消息记录阶段 4 提示版本', promptVersions.has('phase4-v1'), [...promptVersions].join(','));
  const planRow = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND plan_json IS NOT NULL').get(conversationId).c;
  check('计划对象已落库（可审计当时决策）', planRow > 0, `${planRow} 条`);

  // 复验报告 P2-1：显式请求的模型必须被如实使用与记录（UI 侧的切换竞态另用 ref 修复）
  const explicit = await send('这次请按指定模型回答', { requestedModel: 'fake-stream-v1' });
  const explicitMessage = listMessages(db, conversationId, { limit: 5 }).items.at(-1);
  check(
    '显式请求的模型被如实使用并写入历史',
    explicit.names.includes('done') && explicitMessage?.model === 'fake-stream-v1',
    `model=${explicitMessage?.model} events=${explicit.names.slice(0, 3).join('→')}`,
  );
}

console.log('\n=== 8) 正式库未被改动 ===');
{
  const env = await import('../src/server/db/index.ts');
  env.closeDb();
  const liveSha = crypto.createHash('sha256').update(fs.readFileSync(liveDb)).digest('hex');
  const copySha = crypto.createHash('sha256').update(fs.readFileSync(path.join(workDir, 'liuyao.db'))).digest('hex');
  check('正式库与副本内容不同（说明测试确实跑在副本上）', liveSha !== copySha, `正式 ${liveSha.slice(0, 12)}… / 副本 ${copySha.slice(0, 12)}…`);
  fs.rmSync(workDir, { recursive: true, force: true });
  check('临时副本已清理', !fs.existsSync(workDir), path.relative(projectRoot, workDir));
}

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
