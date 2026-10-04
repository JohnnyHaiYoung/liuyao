// 交付形态复验：把**实际交付 ZIP** 解包到安全目标目录，校验包内 PACK-MANIFEST.txt 的逐文件哈希，
// 再把副本的 F 盘来源目录改为不存在的盘符并在副本内运行 verify —— 只允许"外部原件不可访问"的警告。
//
// 安全与可移植性（2026-10-04 二次复验 P1-3 要求）：
//   - 项目位置由脚本自身路径推导，不硬编码本机路径，部署到任意目录都指向被测目录；
//   - 归档路径必须显式传入（`node tools/offline/accept-unpack-test.mjs <归档.zip> [解包目录]`），
//     不按文件名猜测；解包目录默认在本项目 storage/tmp 下，且必须为空目录或允许被清空。
//   - 不改动正式资料：只读取归档，写入仅在解包目录内。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readZip } from '../lib/office.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const archiveArg = process.argv[2];
if (!archiveArg) {
  console.error('用法：node tools/offline/accept-unpack-test.mjs <归档.zip> [解包目录]');
  console.error('（不按文件名猜测归档；请显式传入交付包路径）');
  process.exit(2);
}
const archivePath = path.resolve(archiveArg);
if (!fs.existsSync(archivePath)) throw new Error(`归档不存在：${archivePath}`);

const target = path.resolve(process.argv[3] ?? path.join(repo, 'storage', 'tmp', 'accept-unpack'));
const allowedRoot = path.join(repo, 'storage', 'tmp');
if (!target.startsWith(allowedRoot)) throw new Error(`解包目录必须位于 ${allowedRoot} 下（当前：${target}）`);

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
console.log(`解包 ${path.basename(archivePath)} → ${path.relative(repo, target)}（${files} 个文件）`);

// 包内清单逐文件哈希核对（清单自身不参与）。
const manifestEntry = entries.find((entry) => entry.name === 'PACK-MANIFEST.txt');
if (!manifestEntry) throw new Error('归档内缺少 PACK-MANIFEST.txt');
const manifestLines = manifestEntry.content
  .toString('utf8')
  .split('\n')
  .filter((line) => /^[0-9a-f]{64}\s+\d+\s+\S/.test(line));
let hashOk = 0;
const hashBad = [];
for (const line of manifestLines) {
  const [, expectedSha, , relative] = /^([0-9a-f]{64})\s+(\d+)\s+(.+)$/.exec(line);
  const absolute = path.join(target, ...relative.split('/'));
  if (!fs.existsSync(absolute)) {
    hashBad.push(`${relative}（缺失）`);
    continue;
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  if (actual === expectedSha) hashOk += 1;
  else hashBad.push(`${relative}（哈希不符）`);
}
console.log(`包内 PACK-MANIFEST.txt：核对 ${manifestLines.length} 个文件，${hashOk} 个一致${hashBad.length > 0 ? `，${hashBad.length} 个不一致` : ''}`);
for (const item of hashBad.slice(0, 5)) console.error(`  - ${item}`);

// 模拟"没有 F 盘的机器"。
const sampleSetPath = path.join(target, 'tools', 'sample-set.json');
const sampleSet = JSON.parse(fs.readFileSync(sampleSetPath, 'utf8'));
sampleSet.sourceRoot = 'Z:\\absent-liuyao-source';
fs.writeFileSync(sampleSetPath, JSON.stringify(sampleSet, null, 2), 'utf8');

const result = spawnSync('node', ['tools/corpus-cli.ts', 'verify'], { cwd: target, encoding: 'utf8', windowsHide: true });
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const summary = /通过 (\d+) 项；警告 (\d+) 项；失败 (\d+) 项/.exec(output);
const sourceCount = fs.readFileSync(path.join(target, 'corpus', 'manifest.jsonl'), 'utf8').trim().split('\n').length;
console.log('--- 解包副本内的 verify 输出（前 12 行）---');
console.log(output.split('\n').filter((line) => line.trim() !== '').slice(0, 12).join('\n'));

if (!summary) {
  console.error('未能解析 verify 汇总行');
  process.exitCode = 1;
} else {
  const [, ok, warn, fail] = summary;
  const warnExpected = sourceCount; // 每个来源一条"F 盘原件不可访问"警告
  const passes = Number(fail) === 0 && Number(warn) === warnExpected && hashBad.length === 0;
  console.log(
    `\n判定：包内哈希 ${hashOk}/${manifestLines.length} 一致、verify 通过 ${ok}、警告 ${warn}（期望 ${warnExpected}）、失败 ${fail}` +
      ` → ${passes ? '通过' : '不通过'}`,
  );
  process.exitCode = passes ? 0 : 1;
}
