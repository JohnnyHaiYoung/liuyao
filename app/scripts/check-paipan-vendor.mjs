#!/usr/bin/env node
/**
 * 校验 app 内的排盘核心副本与阶段 3 原始模块**逐字节一致**（阶段 4）。
 *
 * 为什么需要副本：Next/webpack 无法解析 app 之外的 TypeScript 源码包（实测
 * `Module not found: Can't resolve 'liuyao-paipan'`），而任务书要求排盘只能由服务端调用
 * 阶段 3 模块完成。本脚本保证副本不会与原始实现漂移。
 *
 * 用法：node app/scripts/check-paipan-vendor.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const originalDir = path.join(projectRoot, 'paipan', 'src');
const vendorDir = path.join(projectRoot, 'app', 'src', 'server', 'chart', 'vendor', 'paipan');
const FILES = ['core.ts', 'calendar.ts', 'rules.ts', 'index.ts'];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};

console.log(`原始：${path.relative(projectRoot, originalDir)}`);
console.log(`副本：${path.relative(projectRoot, vendorDir)}\n`);

for (const file of FILES) {
  const original = path.join(originalDir, file);
  const copy = path.join(vendorDir, file);
  const exists = fs.existsSync(original) && fs.existsSync(copy);
  check(`${file} 两侧都存在`, exists, exists ? '' : '缺文件');
  if (!exists) continue;
  const a = sha256(original);
  const b = sha256(copy);
  check(`${file} 逐字节一致`, a === b, a === b ? a.slice(0, 16) + '…' : `原始 ${a.slice(0, 12)}… / 副本 ${b.slice(0, 12)}…（需同步）`);
}

// 规则版本文件仍以 paipan/rules 为单一事实来源，服务端运行时读取
const ruleProfile = path.join(projectRoot, 'paipan', 'rules', 'rule-profile.v1.json');
check('规则版本文件存在（单一事实来源）', fs.existsSync(ruleProfile), fs.existsSync(ruleProfile) ? path.relative(projectRoot, ruleProfile) : '缺失');
if (fs.existsSync(ruleProfile)) {
  const profile = JSON.parse(fs.readFileSync(ruleProfile, 'utf8'));
  check('规则版本号与核心返回一致', profile.ruleProfileVersion === 'liuyao-rule-profile.v1', profile.ruleProfileVersion);
}

// 副本不应引入 app 外部依赖（否则打包会再次失败）
const vendorImports = FILES.flatMap((file) =>
  [...fs.readFileSync(path.join(vendorDir, file), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]),
);
const externalImports = [...new Set(vendorImports.filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:')))];
check('副本只依赖 node:* 与相对路径（除 lunar-typescript）', externalImports.every((item) => item === 'lunar-typescript'), externalImports.join(', ') || '无外部依赖');

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
