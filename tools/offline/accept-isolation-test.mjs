// 复验同哈希别名：同批（a→b）、分批（b 再来一次）、分批反向（a 先 b 后）三种导入顺序。
//
// 安全设计（2026-10-04 复验 P1-3 后重写）：在 storage/tmp 下复制一份 tools/ 作为一次性项目根，
// 所有写入都发生在副本内；正式 corpus/、原件与 manifest.jsonl 只被读取，绝不被改写或删除。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = 'E:\\workspace-ai\\xuanxue\\liuyao';
const tempRootsRoot = path.join(repo, 'storage', 'tmp');
const workRoot = path.join(tempRootsRoot, 'accept-isolation-root');
const sandbox = path.join(workRoot, 'sources');
const sampleSetPath = path.join(sandbox, 'sample-set.json');
const cliPath = path.join(workRoot, 'tools', 'corpus-cli.ts');
const manifestPath = path.join(workRoot, 'corpus', 'manifest.jsonl');

if (path.resolve(workRoot) === path.resolve(repo)) throw new Error('拒绝在正式项目根上运行隔离测试');
if (!path.resolve(workRoot).startsWith(path.resolve(tempRootsRoot))) throw new Error('隔离测试目录必须位于 storage/tmp 下');

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
fs.cpSync(path.join(repo, 'tools'), path.join(workRoot, 'tools'), { recursive: true });

const uniqueText = `六爻快速断卦法测试样本甲\n取用神随所测事类而变，此为隔离复验专用文本，不进入正式资料集。\n`.repeat(4);
const twin = Buffer.from(uniqueText, 'utf8');
fs.writeFileSync(path.join(sandbox, 'copy-a.txt'), twin);
fs.writeFileSync(path.join(sandbox, 'copy-b.txt'), twin);
const twinSha = crypto.createHash('sha256').update(twin).digest('hex');

const writeSet = (samples) =>
  fs.writeFileSync(
    sampleSetPath,
    JSON.stringify({ version: 'accept-test', sourceRoot: sandbox, note: '隔离别名复验', samples, deferred: [] }, null, 2),
    'utf8',
  );
const run = (args) => spawnSync('node', [cliPath, ...args], { cwd: workRoot, encoding: 'utf8', windowsHide: true });
const entryFor = (sha) =>
  fs
    .readFileSync(manifestPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((item) => item.sha256 === sha);

const results = [];
try {
  // A：同批导入（a → b）
  writeSet([
    { role: 'TEST-A', path: 'copy-a.txt', format: 'txt', purpose: '同哈希路径一' },
    { role: 'TEST-B', path: 'copy-b.txt', format: 'txt', purpose: '同哈希路径二' },
  ]);
  run(['import', '--sample-set', sampleSetPath]);
  const afterBatch = entryFor(twinSha);
  results.push({
    name: '同批导入（a → b）',
    pass: afterBatch?.sourceRelativePathFromF === 'copy-a.txt' && afterBatch?.aliasSourcePaths.includes('copy-b.txt'),
    detail: `主路径=${afterBatch?.sourceRelativePathFromF} 别名=${JSON.stringify(afterBatch?.aliasSourcePaths)}`,
  });

  // B：分批，只有 b 的第二批
  writeSet([{ role: 'TEST-B', path: 'copy-b.txt', format: 'txt', purpose: '同哈希路径二（分批）' }]);
  run(['import', '--sample-set', sampleSetPath]);
  const afterSplit = entryFor(twinSha);
  results.push({
    name: '分批导入（b 单独再来一次）',
    pass: afterSplit?.sourceRelativePathFromF === 'copy-a.txt' && afterSplit?.aliasSourcePaths.includes('copy-b.txt'),
    detail: `主路径=${afterSplit?.sourceRelativePathFromF} 别名=${JSON.stringify(afterSplit?.aliasSourcePaths)}`,
  });

  // C：清空副本 manifest，改按 a 先、b 后的顺序
  fs.rmSync(manifestPath, { force: true });
  writeSet([{ role: 'TEST-A', path: 'copy-a.txt', format: 'txt', purpose: '同哈希路径一（先到）' }]);
  run(['import', '--sample-set', sampleSetPath]);
  writeSet([{ role: 'TEST-B', path: 'copy-b.txt', format: 'txt', purpose: '同哈希路径二（后到）' }]);
  run(['import', '--sample-set', sampleSetPath]);
  const afterOrdered = entryFor(twinSha);
  results.push({
    name: '分批另一种顺序（a 先、b 后）',
    pass: afterOrdered?.sourceRelativePathFromF === 'copy-a.txt' && afterOrdered?.aliasSourcePaths.includes('copy-b.txt'),
    detail: `主路径=${afterOrdered?.sourceRelativePathFromF} 别名=${JSON.stringify(afterOrdered?.aliasSourcePaths)}`,
  });

  console.log(`隔离项目根：${path.relative(repo, workRoot)}（副本，正式 corpus/ 未被访问）`);
  console.log('\n=== 同哈希别名复验结果 ===');
  for (const item of results) console.log(`  [${item.pass ? '通过' : '不通过'}] ${item.name}\n         ${item.detail}`);
  console.log(`\n合计：${results.filter((item) => item.pass).length}/${results.length} 通过`);
  process.exitCode = results.every((item) => item.pass) ? 0 : 1;
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
  console.log('已删除隔离项目根（正式资料未改动）');
}
