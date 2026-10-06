#!/usr/bin/env node
/**
 * 0002 迁移与快照读写的离线验证（阶段 4 任务书第 6、7.4、7.6 节）。
 *
 * 做法：用**阶段 1 真实旧库的副本**（含 -wal/-shm）在项目内可丢弃目录里跑 app 的真实迁移器，
 * 断言：旧数据一行未动、新表/新列就位、快照可写可读、重复迁移幂等，且**正式库文件哈希不变**。
 *
 * 用法：node app/scripts/check-migration-phase4.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const projectRoot = path.resolve(appDir, '..');
const liveStorage = path.join(projectRoot, 'storage');
const liveDb = path.join(liveStorage, 'liuyao.db');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};
const sha256File = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

if (!fs.existsSync(liveDb)) {
  console.error(`找不到阶段 1 正式库：${liveDb}（本脚本需要一个旧库副本来验证迁移）`);
  process.exit(2);
}

console.log('=== 0) 先用只读连接记录正式库状态，并复制副本（绝不改正式库） ===');
const liveBefore = {
  db: sha256File(liveDb),
  wal: sha256File(`${liveDb}-wal`),
  shm: sha256File(`${liveDb}-shm`),
};

const { default: Database } = await import('better-sqlite3');
const liveReader = new Database(liveDb, { readonly: true });
const readSnapshot = (db) => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name);
  const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all().map((row) => row.name);
  const migrations = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  const messages = db
    .prepare('SELECT id, conversation_id, role, content, status, provider, model, created_at FROM messages ORDER BY id')
    .all();
  const conversations = db.prepare('SELECT id, title, title_source, created_at, updated_at FROM conversations ORDER BY id').all();
  return { tables, messageColumns, conversationColumns, migrations, messages, conversations };
};
const before = readSnapshot(liveReader);
liveReader.close();
check('读到阶段 1 旧库状态', before.messages.length >= 0, `消息 ${before.messages.length} 条、会话 ${before.conversations.length} 个、表 ${before.tables.length} 个、迁移 ${before.migrations.map((m) => m.version).join(',') || '（无）'}`);

const workDir = path.join(liveStorage, 'tmp', `migration-check-${process.pid}`);
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const source = `${liveDb}${suffix}`;
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(workDir, `liuyao.db${suffix}`));
}
const copyDb = path.join(workDir, 'liuyao.db');
check('副本已创建（含 wal/shm）', fs.existsSync(copyDb), path.relative(projectRoot, copyDb));

console.log('\n=== 1) 用 app 的真实迁移器升级副本 ===');
process.env.LIUYAO_STORAGE_DIR = workDir;
process.env.LIUYAO_MIGRATIONS_DIR = path.join(appDir, 'migrations');
const dbModule = await import('../src/server/db/index.ts');
const db = dbModule.getDb();
const applied = dbModule.listAppliedMigrations(db);
check('迁移器已应用 0001 与 0002', applied.some((m) => m.version === 1) && applied.some((m) => m.version === 2), applied.map((m) => `${m.version}:${m.name}`).join(' '));

const after = readSnapshot(db);
check('旧消息一行未少、内容未变', JSON.stringify(after.messages) === JSON.stringify(before.messages), `消息 ${before.messages.length} → ${after.messages.length}`);
check('旧会话标题/来源未变', JSON.stringify(after.conversations) === JSON.stringify(before.conversations), `会话 ${before.conversations.length} 个`);
check('新增 chart_runs 表', after.tables.includes('chart_runs') && !before.tables.includes('chart_runs'), 'chart_runs');
check('新增 message_sources 表', after.tables.includes('message_sources') && !before.tables.includes('message_sources'), 'message_sources');
check('messages 新增 chart_run_id/plan_json', ['chart_run_id', 'plan_json'].every((column) => after.messageColumns.includes(column) && !before.messageColumns.includes(column)), after.messageColumns.join(','));
check('提示版本字段沿用阶段 1 既有列（0002 不重复添加）', before.messageColumns.includes('prompt_version') && after.messageColumns.includes('prompt_version'), 'prompt_version');
check('conversations 新增 current_chart_run_id', after.conversationColumns.includes('current_chart_run_id') && !before.conversationColumns.includes('current_chart_run_id'), '');
check('旧消息的 chart_run_id 为空（读出即“无盘”）', db.prepare('SELECT COUNT(*) AS c FROM messages WHERE chart_run_id IS NOT NULL').get().c === 0, '');

console.log('\n=== 2) 幂等：重复应用迁移不重复执行 ===');
const appliedAgain = dbModule.applyMigrations(db, path.join(appDir, 'migrations'));
check('再次应用后迁移条数不变', appliedAgain.length === applied.length, `${applied.length} → ${appliedAgain.length}`);
const beforeCounts = { messages: db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, conversations: db.prepare('SELECT COUNT(*) AS c FROM conversations').get().c };

console.log('\n=== 3) 快照读写（盘面 + 来源） ===');
const { createChartRun } = await import('../src/server/chart/service.ts');
const snapshots = await import('../src/server/chart/snapshots.ts');

const conversationId = after.conversations[0]?.id ?? null;
if (!conversationId) {
  check('存在可用于挂载快照的会话', false, '旧库里没有会话，无法验证外键关联');
} else {
  // 必须取**同一会话**下的助手消息：历史接口按会话查询，跨会话取会读不到
  const messageId = after.messages.find((row) => row.conversation_id === conversationId && row.role === 'assistant')?.id
    ?? after.messages.find((row) => row.conversation_id === conversationId)?.id
    ?? null;
  const run = createChartRun({ lineValues: [8, 7, 8, 8, 8, 7], mode: 'manual_calendar', dayGanzhi: '戊辰', monthBranch: '申', sourceInput: '帮我看看这卦：8 7 8 8 8 7，戊辰日申月' });
  if (!run.ok) {
    check('生成盘面快照', false, `${run.errorCode}: ${run.message}`);
  } else {
    const chartRunId = snapshots.insertChartRun(db, { conversationId, createdByMessageId: messageId, sourceInput: '帮我看看这卦', result: run });
    const stored = snapshots.getChartRun(db, chartRunId);
    check('盘面快照可写可读', stored !== null && stored.chartJson === run.canonicalJson, stored ? `hash=${stored.canonicalHash.slice(0, 16)}… 版本=${stored.ruleProfileVersion}/${stored.coreVersion}` : '读取失败');
    check('快照保留输入原文与历法来源', stored?.sourceInput === '帮我看看这卦' && stored?.dayGanzhi === '戊辰' && stored?.mode === 'manual_calendar', `${stored?.sourceInput} / ${stored?.dayGanzhi} / ${stored?.mode}`);

    if (messageId) {
      snapshots.bindMessageChart(db, { messageId, chartRunId, planJson: JSON.stringify({ intent: 'chart', chartAction: 'new' }), promptVersion: 'phase4-v1' });
      const bound = snapshots.getChartRunForMessage(db, messageId);
      check('消息绑定后可按消息读回同一快照', bound?.id === chartRunId, bound ? 'ok' : '未读到');
      const messageRow = db.prepare('SELECT plan_json, prompt_version FROM messages WHERE id = ?').get(messageId);
      check('消息同时保留计划对象与提示版本', typeof messageRow.plan_json === 'string' && messageRow.prompt_version === 'phase4-v1', String(messageRow.prompt_version));
      snapshots.setCurrentChartRun(db, conversationId, chartRunId);
      check('会话当前盘引用可读回', snapshots.getCurrentChartRun(db, conversationId)?.id === chartRunId, '');
    }

    const inserted = snapshots.insertMessageSources(db, messageId ?? chartRunId, [
      { sid: 'S1', sourceId: 'src-08862b06aea9', pagePath: 'wiki/concepts/yongshen.md', locatorType: 'paragraph', locatorValue: '¶0002', qualityStatus: 'needs_review', excerpt: '用神者……', pageSha256: 'a'.repeat(64) },
      { sid: 'S2', sourceId: 'src-3f8243c07930', pagePath: 'wiki/sources/src-3f8243c07930.md', locatorType: 'paragraph', locatorValue: '¶0003', qualityStatus: 'usable', excerpt: '取用神之法……', pageSha256: 'b'.repeat(64) },
    ]);
    const listed = snapshots.listMessageSources(db, messageId ?? chartRunId);
    check('来源快照批量写入并可读回', inserted === 2 && listed.length === 2, listed.map((item) => `${item.sid}:${item.sourceId}:${item.locatorValue}`).join(' '));
    check('来源快照保留质量与页哈希（供历史回看旧版本）', listed.every((item) => item.pageSha256.length === 64 && ['usable', 'needs_review'].includes(item.qualityStatus)), '');

    // 失败盘不写完整盘面
    const failedId = snapshots.insertFailedChartRun(db, { conversationId, sourceInput: '帮我起卦', lineValues: [5, 7, 8, 8, 8, 7], errorCode: 'invalid_line_value' });
    const failed = snapshots.getChartRun(db, failedId);
    check('失败记录只存错误码、不存盘面', failed?.errorCode === 'invalid_line_value' && failed?.chartJson === '', `${failed?.errorCode}`);

    // 历史回看：走真实仓储函数（历史 GET 用的就是它），验证与 done 事件同源的快照
    const messagesRepo = await import('../src/server/db/messages.ts');
    const page = messagesRepo.listMessages(db, conversationId, { limit: 50 });
    const bound = page.items.find((item) => item.id === messageId);
    check(
      '历史 GET 返回同一盘面快照（哈希与版本一致）',
      bound?.chart?.chartRunId === chartRunId && bound?.chart?.canonicalHash === run.canonicalHash && bound.chart.ruleProfileVersion === 'liuyao-rule-profile.v1' && bound.chart.coreVersion === 'paipan-core/0.1.0',
      bound?.chart ? `${bound.chart.chartRunId.slice(0, 8)}… ${bound.chart.canonicalHash.slice(0, 12)}…` : '未读到盘面',
    );
    check(
      '历史 GET 的盘面摘要字段完整（卦名/宫/世应/旬空/历法）',
      bound?.chart?.summary?.originalHexagram === '山水蒙' && bound.chart.summary.palace === '离宫' && bound.chart.summary.shiPosition === 1 + 3 && Array.isArray(bound.chart.summary.voidBranches),
      bound?.chart ? `${bound.chart.summary.originalHexagram} ${bound.chart.summary.palace}${bound.chart.summary.palaceStage} 世${bound.chart.summary.shiPosition}应${bound.chart.summary.yingPosition}` : '',
    );
    check(
      '历史 GET 返回来源快照（sid/来源/定位/质量/页哈希）',
      bound?.sources?.length === 2 && bound.sources.every((item) => item.href.startsWith('/api/sources/') && item.sourceId.startsWith('src-') && item.label.includes('来源')),
      bound?.sources ? bound.sources.map((item) => `${item.sid}:${item.sourceId}:${item.locatorValue}`).join(' ') : '未读到来源',
    );
    check('历史 GET 的引用链接为服务端生成（模型无法注入）', bound?.sources?.every((item) => item.href === `/api/sources/${item.sourceId}${item.locatorValue ? `?locator=${encodeURIComponent(item.locatorValue)}` : ''}`) === true, bound?.sources?.[0]?.href ?? '');
    const oldUserMessage = page.items.find((item) => item.role === 'user');
    check('阶段 1 旧消息在历史里仍为“无盘无来源”', oldUserMessage?.chart === null && oldUserMessage?.sources === null, `${oldUserMessage?.id?.slice(0, 8) ?? '(无)'}`);
    check('旧消息原有字段未受快照接入影响', typeof oldUserMessage?.content === 'string' && typeof oldUserMessage?.status === 'string' && 'model' in (oldUserMessage ?? {}), oldUserMessage ? `${oldUserMessage.status}/${oldUserMessage.model ?? '-'}` : '');
  }
}

console.log('\n=== 4) 旧数据仍然完好，且正式库未被改动 ===');
const finalCounts = { messages: db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, conversations: db.prepare('SELECT COUNT(*) AS c FROM conversations').get().c };
check('会话/消息总数不变', beforeCounts.messages === finalCounts.messages && beforeCounts.conversations === finalCounts.conversations, `messages ${finalCounts.messages} / conversations ${finalCounts.conversations}`);
const finalOld = readSnapshot(db);
check(
  '旧字段（content/status/title/model）逐行未变',
  JSON.stringify(finalOld.messages.map((row) => ({ ...row, chart_run_id: undefined, plan_json: undefined, prompt_version: undefined }))) ===
    JSON.stringify(before.messages.map((row) => ({ ...row, chart_run_id: undefined, plan_json: undefined, prompt_version: undefined }))) ||
    before.messages.every((row, index) => {
      const now = finalOld.messages[index];
      return now && now.id === row.id && now.content === row.content && now.status === row.status && now.model === row.model;
    }),
  `${before.messages.length} 条旧消息逐条比对`,
);
dbModule.closeDb();

const liveAfter = { db: sha256File(liveDb), wal: sha256File(`${liveDb}-wal`), shm: sha256File(`${liveDb}-shm`) };
check('正式库文件未被本脚本改动', JSON.stringify(liveBefore) === JSON.stringify(liveAfter), `db=${String(liveBefore.db).slice(0, 12)}…`);

fs.rmSync(workDir, { recursive: true, force: true });
check('临时副本已清理', !fs.existsSync(workDir), path.relative(projectRoot, workDir));

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
