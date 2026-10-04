// 复验门槛 2：隔离混合批次（损坏的旧 DOC + 零字节 TXT + 正常 TXT）。
//
// 安全设计（2026-10-04 复验 P1-3 后重写）：脚本把 tools/ 复制到 storage/tmp 下的一个
// 一次性项目根，所有导入、提取、清洗都发生在那个副本里；正式 corpus/、corpus/originals/、
// corpus/manifest.jsonl 只被读取（复制 tools/），**绝不被写入或删除**。脚本结束时整棵临时
// 项目根随删，因此也不存在"删除同名原件"的风险。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = 'E:\\workspace-ai\\xuanxue\\liuyao';
const tempRootsRoot = path.join(repo, 'storage', 'tmp');
const workRoot = path.join(tempRootsRoot, 'accept-invalid-batch-root');
const sandbox = path.join(workRoot, 'sources');
const sampleSetPath = path.join(sandbox, 'sample-set.json');
const cliPath = path.join(workRoot, 'tools', 'corpus-cli.ts');
const manifestPath = path.join(workRoot, 'corpus', 'manifest.jsonl');

if (path.resolve(workRoot) === path.resolve(repo)) throw new Error('拒绝在正式项目根上运行隔离测试');
if (!path.resolve(workRoot).startsWith(path.resolve(tempRootsRoot))) throw new Error('隔离测试目录必须位于 storage/tmp 下');

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
fs.cpSync(path.join(repo, 'tools'), path.join(workRoot, 'tools'), { recursive: true });

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

const run = (args) => spawnSync('node', [cliPath, ...args], { cwd: workRoot, encoding: 'utf8', windowsHide: true });
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
  const find = (name) => entries.find((item) => item.sourceRelativePathFromF === name);
  const broken = find('broken.doc');
  const empty = find('empty.txt');
  const ok = find('ok.txt');
  const cleanedExists = (entry) =>
    Boolean(entry?.processing.cleanedPath && fs.existsSync(path.join(workRoot, entry.processing.cleanedPath)));

  results.push({
    name: '损坏 DOC 记为 failed 且写明原因、无清洗文件',
    pass:
      broken?.processing.status === 'failed' &&
      broken?.coverage.quality === 'failed' &&
      (broken?.coverage.issues.length ?? 0) >= 2 &&
      !cleanedExists(broken),
    detail: `状态=${broken?.processing.status}/${broken?.coverage.quality} 原因条数=${broken?.coverage.issues.length ?? 0} 清洗文件=${broken?.processing.cleanedPath ?? '无'}｜原因：${(broken?.coverage.issues[0] ?? '').slice(0, 60)}`,
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
  const output = `${extract.stdout ?? ''}${extract.stderr ?? ''}`;
  results.push({
    name: '批量以非零退出码并汇总失败数',
    pass: extract.status === 1 && /提取失败 1 个来源/.test(output),
    detail: `exit=${extract.status}；汇总行${/提取失败 1 个来源/.test(output) ? '已输出' : '缺失'}`,
  });

  console.log(`隔离项目根：${path.relative(repo, workRoot)}（副本，正式 corpus/ 未被访问）`);
  console.log('\n=== 混合批次复验结果 ===');
  for (const item of results) console.log(`  [${item.pass ? '通过' : '不通过'}] ${item.name}\n         ${item.detail}`);
  console.log(`\n合计：${results.filter((item) => item.pass).length}/${results.length} 通过`);
  process.exitCode = results.every((item) => item.pass) ? 0 : 1;
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
  console.log('已删除隔离项目根（正式资料未改动）');
}
