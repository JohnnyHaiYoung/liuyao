#!/usr/bin/env node
/**
 * 一键跑完全部自检（阶段 4 交付用）。
 *
 * 为什么需要它：验收方在 Windows PowerShell 5.1 下用 `npm run a && npm run b` 会因
 * "&& 不是有效语句分隔符"而**一条都不执行**（那是 pwsh 7 的语法）。本脚本用 Node
 * 顺序调用各检查，跨 shell 一致，并汇总通过/失败与退出码。
 *
 * 用法（任选其一）：
 *   npm run check:all                 # 全部离线检查（不需要密钥/网络）
 *   npm run check:all -- --with-http   # additionally 跑阶段 1 HTTP 运行态回归（会临时起服务）
 *   npm run check:all -- --with-live   # additionally 跑真实上游联调（需要密钥，会产生极小费用）
 *
 * 子进程用 stdio: 'inherit' 直接透传输出，避免在受限环境里因管道捕获失败（EPERM）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const withHttp = process.argv.includes('--with-http');
const withLive = process.argv.includes('--with-live');

/** 每项：[名称, node 参数数组]（-i 表示需要 TS 解析钩子） */
const checks = [
  ['wiki 目录一致性', ['scripts/build-wiki-catalog.mjs', '--check']],
  ['wiki 选页与证据片段', ['scripts/check-wiki-select.mjs']],
  ['来源读取与出处接口安全', ['scripts/check-source-reader.mjs']],
  ['排盘适配（与阶段 3 CLI 逐字段一致）', ['scripts/check-chart-service.mjs']],
  ['编排层（意图/引用/上下文/注入边界）', ['scripts/check-orchestration.mjs']],
  ['排盘副本一致性', ['scripts/check-paipan-vendor.mjs']],
  ['旧库迁移与快照读写', ['scripts/check-migration-phase4.mjs'], 'ts'],
  ['端到端（假模型，四条主流程）', ['scripts/check-phase4-e2e.mjs'], 'ts'],
  ['千问适配器（本地模拟上游）', ['scripts/check-qwen-adapter.mjs'], 'ts'],
];

if (withHttp) checks.push(['阶段 1 HTTP 运行态回归', ['scripts/check-phase1-regression.mjs']]);
if (withLive) {
  checks.push(['真实上游连通性（不耗 token）', ['scripts/check-provider-live.mjs'], 'ts']);
  checks.push(['真实模型走完整聊天流程', ['scripts/check-provider-real-e2e.mjs'], 'ts']);
}

// node --import 需要 URL 而不是 Windows 绝对路径（否则会被当成协议 e:）
const hook = pathToFileURL(path.join(appDir, 'scripts', 'lib', 'register-ts.mjs')).href;
const results = [];

console.log(`一键自检：共 ${checks.length} 项${withHttp ? '（含 HTTP 回归）' : ''}${withLive ? '（含真实联调）' : ''}\n`);

for (const [name, args, mode] of checks) {
  console.log(`${'─'.repeat(72)}\n▶ ${name}\n${'─'.repeat(72)}`);
  const cliArgs = mode === 'ts' ? ['--import', hook, ...args] : args;
  const run = spawnSync(process.execPath, cliArgs, { cwd: appDir, stdio: 'inherit', windowsHide: true });
  const ok = run.status === 0;
  results.push({ name, ok, status: run.status });
  console.log(ok ? `✔ ${name} 通过\n` : `✘ ${name} 未通过（退出码 ${run.status ?? 'null'}）\n`);
}

console.log('═'.repeat(72));
console.log('汇总：');
for (const item of results) console.log(`  ${item.ok ? '通过' : '未通过'}  ${item.name}`);
const failed = results.filter((item) => !item.ok);
console.log(`\n合计：${results.length - failed.length}/${results.length} 项通过${failed.length ? `，未通过：${failed.map((item) => item.name).join('、')}` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
