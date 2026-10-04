// 复验门槛 2：隔离的混合批次（损坏的旧 DOC + 零字节 TXT + 正常 TXT）。
// 要求：失败来源记为 failed 并写明原因、不生成清洗文件；正常来源照常完成；命令以非零退出码报告失败数。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = 'E:\\workspace-ai\\xuanxue\\liuyao';
const sandbox = path.join(root, 'storage', 'tmp', 'accept-invalid-batch');
const manifestPath = path.join(root, 'corpus', 'manifest.jsonl');
const backupPath = path.join(root, 'storage', 'tmp', 'manifest-backup-batch.jsonl');
const sampleSetPath = path.join(sandbox, 'sample-set.json');

fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
fs.copyFileSync(manifestPath, backupPath);

// 1) 19 字节、扩展名 .doc 但不是 OLE2 的文件；2) 零字节 TXT；3) 正常 TXT
fs.writeFileSync(path.join(sandbox, 'broken.doc'), 'not an OLE2 document', 'latin1');
fs.writeFileSync(path.join(sandbox, 'empty.txt'), '');
fs.writeFileSync(
  path.join(sandbox, 'ok.txt'),
  '六爻取用神随所测事类而变；本文件用于隔离批次复验，内容为测试用途，不进入正式资料集。\n取用神错了，生克用得再熟也无用。\n',
  'utf8',
);
fs.writeFileSync(
  sampleSetPath,
  JSON.stringify(
    {
      version: 'accept-test',
      sourceRoot: sandbox,
      note: '隔离混合批次（损坏 DOC + 空 TXT + 正常 TXT）',
      samples: [
        { role: 'TEST-BROKEN-DOC', path: 'broken.doc', format: 'doc', purpose: '签名错误的 .doc' },
        { role: 'TEST-EMPTY', path: 'empty.txt', format: 'txt', purpose: '零字节' },
        { role: 'TEST-OK', path: 'ok.txt', format: 'txt', purpose: '正常文本' },
      ],
      deferred: [],
    },
    null,
    2,
  ),
  'utf8',
);

const run = (args) => spawnSync('node', [path.join('tools', 'corpus-cli.ts'), ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
const manifest = () =>
  fs
    .readFileSync(manifestPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

const results = [];
try {
  run(['import', '--sample-set', sampleSetPath]);
  const extract = run(['extract', '--all', '--sample-set', sampleSetPath]);
  run(['clean', '--all', '--sample-set', sampleSetPath]);
  const entries = manifest();
  const broken = entries.find((item) => item.sourceRelativePathFromF === 'broken.doc');
  const empty = entries.find((item) => item.sourceRelativePathFromF === 'empty.txt');
  const ok = entries.find((item) => item.sourceRelativePathFromF === 'ok.txt');
  const cleanedExists = (entry) => Boolean(entry?.processing.cleanedPath && fs.existsSync(path.join(root, entry.processing.cleanedPath)));

  results.push({
    name: '损坏 DOC 记为 failed 且写明原因',
    pass:
      broken?.processing.status === 'failed' &&
      broken?.coverage.quality === 'failed' &&
      (broken?.coverage.issues.length ?? 0) >= 2 &&
      !cleanedExists(broken),
    detail: `状态=${broken?.processing.status}/${broken?.coverage.quality} 原因条数=${broken?.coverage.issues.length ?? 0} 清洗文件=${broken?.processing.cleanedPath ?? '无'}｜原因：${(broken?.coverage.issues[0] ?? '').slice(0, 70)}`,
  });
  results.push({
    name: '零字节 TXT 记为 failed 且无清洗文件',
    pass: empty?.processing.status === 'failed' && !cleanedExists(empty),
    detail: `状态=${empty?.processing.status}/${empty?.coverage.quality} 清洗文件=${empty?.processing.cleanedPath ?? '无'}`,
  });
  results.push({
    name: '正常 TXT 仍完成（未被坏来源中断）',
    pass: ok?.processing.status === 'processed' && ok?.coverage.quality === 'usable' && cleanedExists(ok),
    detail: `状态=${ok?.processing.status}/${ok?.coverage.quality} 清洗文件=${ok?.processing.cleanedPath ?? '无'}`,
  });
  const failedListed = /提取失败 1 个来源/.test(`${extract.stdout ?? ''}${extract.stderr ?? ''}`);
  results.push({
    name: '批量以非零退出码并汇总失败数',
    pass: extract.status === 1 && failedListed,
    detail: `exit=${extract.status}；汇总行${failedListed ? '已输出' : '缺失'}`,
  });

  console.log('\n=== 混合批次复验结果 ===');
  for (const item of results) console.log(`  [${item.pass ? '通过' : '不通过'}] ${item.name}\n         ${item.detail}`);
  console.log(`\n合计：${results.filter((item) => item.pass).length}/${results.length} 通过`);
  process.exitCode = results.every((item) => item.pass) ? 0 : 1;
} finally {
  fs.copyFileSync(backupPath, manifestPath);
  for (const name of ['broken.doc', 'empty.txt', 'ok.txt']) {
    fs.rmSync(path.join(root, 'corpus', 'originals', name), { force: true });
  }
  for (const dir of ['extracted', 'cleaned']) {
    const target = path.join(root, 'corpus', dir);
    for (const file of fs.readdirSync(target)) {
      const head = fs.readFileSync(path.join(target, file), 'utf8').slice(0, 800);
      if (head.includes('accept-invalid-batch') || head.includes('broken.doc') || head.includes('ok.txt') || head.includes('empty.txt')) {
        fs.rmSync(path.join(target, file), { force: true });
      }
    }
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(`已恢复 manifest（${fs.readFileSync(manifestPath, 'utf8').trim().split('\n').length} 个来源）并清除测试产物`);
}
