// 复验脚本（隔离样本集）：验证验收报告 P1-3（同哈希的两个原始路径都要保留为别名，同批与
// 分批两种导入顺序）与 P1-4（零字节/不可读输入必须 failed，且不生成清洗文件）。
// 运行时会临时写入 corpus/，结束后从备份恢复 manifest 并删除测试产物。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = 'E:\\workspace-ai\\xuanxue\\liuyao';
const sandbox = path.join(root, 'storage', 'tmp', 'accept-isolation');
const manifestPath = path.join(root, 'corpus', 'manifest.jsonl');
const backupPath = path.join(root, 'storage', 'tmp', 'manifest-backup.jsonl');
const sampleSetPath = path.join(sandbox, 'sample-set.json');
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
fs.copyFileSync(manifestPath, backupPath);

// 使用语料库中不存在的独特内容，确保同哈希两份形成独立条目（复现验收方的场景）。
const uniqueText = `六爻快速断卦法测试样本甲\n取用神随所测事类而变，此为隔离复验专用文本，不进入正式资料集。\n`.repeat(4);
const twinBuffer = Buffer.from(uniqueText, 'utf8');
fs.writeFileSync(path.join(sandbox, 'copy-a.txt'), twinBuffer);
fs.writeFileSync(path.join(sandbox, 'copy-b.txt'), twinBuffer);
fs.writeFileSync(path.join(sandbox, 'empty.txt'), '');
const twinSha = sha256(twinBuffer);
const emptySha = sha256(Buffer.from(''));

function writeSampleSet(samples) {
  fs.writeFileSync(
    sampleSetPath,
    JSON.stringify({ version: 'accept-test', sourceRoot: sandbox, note: '隔离复验样本集（P1-3 / P1-4）', samples, deferred: [] }, null, 2),
    'utf8',
  );
}
function run(args) {
  const result = spawnSync('node', [path.join('tools', 'corpus-cli.ts'), ...args], { cwd: root, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stdout ?? '');
    console.error(result.stderr ?? '');
    throw new Error(`命令失败（exit ${result.status}）：${args.join(' ')}`);
  }
}
function entryFor(sha) {
  return fs
    .readFileSync(manifestPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((item) => item.sha256 === sha);
}
const results = [];
try {
  // 场景 A：同批导入同哈希两路径（先 a 后 b）
  writeSampleSet([
    { role: 'TEST-A', path: 'copy-a.txt', format: 'txt', purpose: '同哈希路径一' },
    { role: 'TEST-B', path: 'copy-b.txt', format: 'txt', purpose: '同哈希路径二' },
  ]);
  run(['import', '--sample-set', sampleSetPath]);
  const afterBatch = entryFor(twinSha);
  results.push({
    name: 'P1-3 同批导入（a → b）',
    pass: afterBatch?.sourceRelativePathFromF === 'copy-a.txt' && afterBatch?.aliasSourcePaths.includes('copy-b.txt'),
    detail: `主路径=${afterBatch?.sourceRelativePathFromF} 别名=${JSON.stringify(afterBatch?.aliasSourcePaths)}`,
  });

  // 场景 B：分批导入（只有 b 的第二批）
  writeSampleSet([{ role: 'TEST-B', path: 'copy-b.txt', format: 'txt', purpose: '同哈希路径二（分批）' }]);
  run(['import', '--sample-set', sampleSetPath]);
  const afterSplit = entryFor(twinSha);
  results.push({
    name: 'P1-3 分批导入（b 单独再来一次）',
    pass: afterSplit?.sourceRelativePathFromF === 'copy-a.txt' && afterSplit?.aliasSourcePaths.includes('copy-b.txt'),
    detail: `主路径=${afterSplit?.sourceRelativePathFromF} 别名=${JSON.stringify(afterSplit?.aliasSourcePaths)}`,
  });

  // 场景 C：另一种顺序（只有 a 的先到，再 b）
  fs.rmSync(manifestPath, { force: true });
  writeSampleSet([{ role: 'TEST-A', path: 'copy-a.txt', format: 'txt', purpose: '同哈希路径一（先到）' }]);
  run(['import', '--sample-set', sampleSetPath]);
  writeSampleSet([{ role: 'TEST-B', path: 'copy-b.txt', format: 'txt', purpose: '同哈希路径二（后到）' }]);
  run(['import', '--sample-set', sampleSetPath]);
  const afterOrdered = entryFor(twinSha);
  results.push({
    name: 'P1-3 分批另一种顺序（a 先、b 后）',
    pass: afterOrdered?.sourceRelativePathFromF === 'copy-a.txt' && afterOrdered?.aliasSourcePaths.includes('copy-b.txt'),
    detail: `主路径=${afterOrdered?.sourceRelativePathFromF} 别名=${JSON.stringify(afterOrdered?.aliasSourcePaths)}`,
  });

  // 场景 D：零字节文件
  writeSampleSet([{ role: 'TEST-EMPTY', path: 'empty.txt', format: 'txt', purpose: '零字节文件' }]);
  run(['import', '--sample-set', sampleSetPath]);
  run(['extract', '--all', '--sample-set', sampleSetPath]);
  const cleanOutput = spawnSync('node', [path.join('tools', 'corpus-cli.ts'), 'clean', '--all', '--sample-set', sampleSetPath], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const afterEmpty = entryFor(emptySha);
  const cleanedExists = afterEmpty?.processing.cleanedPath
    ? fs.existsSync(path.join(root, afterEmpty.processing.cleanedPath))
    : false;
  results.push({
    name: 'P1-4 零字节文件',
    pass:
      afterEmpty?.processing.status === 'failed' &&
      afterEmpty?.coverage.quality === 'failed' &&
      !afterEmpty?.processing.cleanedPath &&
      !cleanedExists &&
      (afterEmpty?.coverage.issues.length ?? 0) > 0 &&
      /failed/.test(cleanOutput.stdout ?? ''),
    detail:
      `状态=${afterEmpty?.processing.status}/${afterEmpty?.coverage.quality} 清洗文件=${afterEmpty?.processing.cleanedPath ?? '无'} ` +
      `原因=${(afterEmpty?.coverage.issues[0] ?? '').slice(0, 60)}…`,
  });

  console.log('\n=== 隔离复验结果 ===');
  for (const item of results) console.log(`  [${item.pass ? '通过' : '不通过'}] ${item.name}\n         ${item.detail}`);
  console.log(`\n合计：${results.filter((item) => item.pass).length}/${results.length} 通过`);
  process.exitCode = results.every((item) => item.pass) ? 0 : 1;
} finally {
  fs.copyFileSync(backupPath, manifestPath);
  for (const name of ['copy-a.txt', 'copy-b.txt', 'empty.txt']) {
    fs.rmSync(path.join(root, 'corpus', 'originals', name), { force: true });
  }
  for (const dir of ['extracted', 'cleaned']) {
    const target = path.join(root, 'corpus', dir);
    for (const file of fs.readdirSync(target)) {
      const head = fs.readFileSync(path.join(target, file), 'utf8').slice(0, 800);
      if (head.includes('accept-isolation') || head.includes('copy-a') || head.includes('empty.txt')) {
        fs.rmSync(path.join(target, file), { force: true });
      }
    }
  }
  const reports = path.join(root, 'corpus', 'reports');
  for (const file of fs.readdirSync(reports)) {
    if (!file.endsWith('.md')) continue;
    const head = fs.readFileSync(path.join(reports, file), 'utf8').slice(0, 800);
    if (head.includes('accept-isolation') || head.includes('copy-a')) fs.rmSync(path.join(reports, file), { force: true });
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(`已恢复 manifest 备份（当前 ${fs.readFileSync(manifestPath, 'utf8').trim().split('\n').length} 个来源）并清除测试产物`);
}
