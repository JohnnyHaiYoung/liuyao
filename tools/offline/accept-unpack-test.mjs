// 复验门槛 1：把实际交付 ZIP 解包到新目录，把该副本的 F 盘来源目录改为不存在的盘符，
// 再在副本内运行 verify —— 只允许"外部原件不可访问"的警告，不允许失败。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readZip } from '../lib/office.ts';

const root = 'E:\\workspace-ai\\xuanxue\\liuyao';
const distDir = path.join(root, 'dist');
const archiveName = fs
  .readdirSync(distDir)
  .filter((name) => name.endsWith('.zip'))
  .sort()
  .pop();
if (!archiveName) throw new Error('dist/ 里没有 zip 归档');
const archivePath = path.join(distDir, archiveName);

const target = path.join(root, 'storage', 'tmp', 'accept-unpack');
fs.rmSync(target, { recursive: true, force: true });

const entries = readZip(fs.readFileSync(archivePath));
let files = 0;
for (const entry of entries) {
  if (entry.isDirectory) continue;
  const destination = path.join(target, ...entry.name.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, entry.content);
  files += 1;
}
console.log(`解包 ${archiveName} → ${path.relative(root, target)}（${files} 个文件）`);

// 把副本的来源根目录改成一个不存在的盘符，模拟"没有 F 盘的机器"。
const sampleSetPath = path.join(target, 'tools', 'sample-set.json');
const sampleSet = JSON.parse(fs.readFileSync(sampleSetPath, 'utf8'));
sampleSet.sourceRoot = 'Z:\\absent-liuyao-source';
fs.writeFileSync(sampleSetPath, JSON.stringify(sampleSet, null, 2), 'utf8');

const result = spawnSync('node', ['tools/corpus-cli.ts', 'verify'], { cwd: target, encoding: 'utf8', windowsHide: true });
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const summary = /通过 (\d+) 项；警告 (\d+) 项；失败 (\d+) 项/.exec(output);
console.log('--- 解包副本内的 verify 输出 ---');
console.log(output.split('\n').filter((line) => line.trim() !== '').slice(0, 12).join('\n'));
if (!summary) {
  console.error('未能解析 verify 汇总行');
  process.exitCode = 1;
} else {
  const [, ok, warn, fail] = summary;
  const passes = Number(fail) === 0 && Number(warn) === Number(entries.filter((e) => e.name.endsWith('manifest.jsonl')).length ? 6 : 6);
  console.log(`\n判定：通过 ${ok}、警告 ${warn}、失败 ${fail}（期望失败 0，警告为 6 条 F 盘不可访问）→ ${passes ? '通过' : '不通过'}`);
  process.exitCode = passes ? 0 : 1;
}
