#!/usr/bin/env node
/**
 * 阶段 1 与阶段 4 的 HTTP 运行态回归（可复跑）。
 *
 * 做四件事（全部在**独立测试库**上，绝不碰正式 storage/liuyao.db）：
 *   1) 生成仅本次使用的验收口令哈希；
 *   2) 用空测试库 + LIUYAO_FAKE_MODEL=1 启动 `next start`（假模型不联网、不产生费用）；
 *   3) 等 healthz 就绪后运行既有 `verify-phase1.mjs`（登录、SSE、停止生成、分页、两处重命名等）；
 *   4) 结束后关掉服务并清理测试库目录。
 *
 * 用法：node app/scripts/check-phase1-regression.mjs [--port 3010]
 * 说明：不冒充真实 API 联调——本回归用的是本地假模型；真实 DeepSeek/千问联调需密钥。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const projectRoot = path.resolve(appDir, '..');

const argValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const port = Number.parseInt(argValue('--port', '3010'), 10);
const baseUrl = `http://127.0.0.1:${port}`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};

const store = path.join(projectRoot, 'storage', 'tmp', `phase1-regression-${process.pid}`);
fs.rmSync(store, { recursive: true, force: true });
fs.mkdirSync(store, { recursive: true });

// 1) 口令哈希（走脚本本身，保证与运行时校验逻辑一致）
const password = `phase4-regression-${crypto.randomBytes(4).toString('hex')}`;
const hashRun = spawnSync('node', [path.join(appDir, 'scripts', 'hash-password.mjs'), password], {
  encoding: 'utf8',
  cwd: appDir,
  windowsHide: true,
});
const passwordHash = (hashRun.stdout ?? '').trim().split(/\r?\n/).filter((line) => line.trim() !== '').pop() ?? '';
check('生成验收口令哈希', /^scrypt:|^[0-9a-f]{64}$/.test(passwordHash), `${passwordHash.slice(0, 12)}…`);

console.log(`\n启动测试服务 ${baseUrl}（测试库 ${path.relative(projectRoot, store)}，假模型，不联网）`);
const server = spawn(process.execPath, [path.join(appDir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)], {
  cwd: appDir,
  // 不使用管道捕获：受限环境下管道会 EPERM；日志直接丢弃也可（healthz 会证明是否就绪）
  stdio: 'ignore',
  env: {
    ...process.env,
    LIUYAO_STORAGE_DIR: store,
    LIUYAO_MIGRATIONS_DIR: path.join(appDir, 'migrations'),
    LIUYAO_OWNER_PASSWORD_HASH: passwordHash,
    LIUYAO_FAKE_MODEL: '1',
    PORT: String(port),
    DEEPSEEK_API_KEY: '',
  },
});

let ready = false;
for (let attempt = 1; attempt <= 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    const response = await fetch(`${baseUrl}/api/healthz`);
    if (response.ok) {
      const body = await response.json();
      ready = true;
      check('服务就绪且迁移已应用（含 0002）', body?.database?.ok === true && Number(body?.database?.migrations) >= 2, `migrations=${body?.database?.migrations} mode=${body?.llm?.mode}`);
      break;
    }
  } catch {
    /* 还没起来 */
  }
}

if (ready) {
  try {
    const unauthorized = await fetch(`${baseUrl}/api/conversations`);
    check('未登录访问被拒（401）', unauthorized.status === 401, `HTTP ${unauthorized.status}`);
  } catch (error) {
    check('未登录访问被拒（401）', false, String(error));
  }

  console.log('\n=== 运行既有阶段 1 验收脚本（HTTP 运行态） ===');
  const verify = spawnSync('node', [path.join(appDir, 'scripts', 'verify-phase1.mjs'), '--base-url', baseUrl, '--password', password, '--storage', store], {
    encoding: 'utf8',
    cwd: appDir,
    windowsHide: true,
    env: { ...process.env, LIUYAO_VERIFY_PASSWORD: password },
  });
  const output = `${verify.stdout ?? ''}\n${verify.stderr ?? ''}`;
  const summaryLine = output.split(/\r?\n/).filter((line) => line.includes('通过') && line.includes('未通过')).pop() ?? '(未找到汇总行)';
  console.log(output.split(/\r?\n/).filter((line) => line.startsWith('[通过]') || line.startsWith('[未通过]') || line.startsWith('[受阻]')).slice(-6).map((line) => `  ${line}`).join('\n'));
  check('阶段 1 自检全部通过（0 未通过、0 受阻）', verify.status === 0, summaryLine.trim());
  check('SSE 序列含阶段 4 的 sources 事件', /start → sources → delta → done/.test(output), '');
} else {
  check('服务就绪', false, '超时未就绪');
}

server.kill();
await new Promise((resolve) => setTimeout(resolve, 1500));
try {
  await fetch(`${baseUrl}/api/healthz`);
  check('测试服务已停止', false, '仍在响应');
} catch {
  check('测试服务已停止', true, '');
}
const liveDb = path.join(projectRoot, 'storage', 'liuyao.db');
check('测试库与正式库分离', fs.existsSync(path.join(store, 'liuyao.db')) && fs.existsSync(liveDb), path.relative(projectRoot, store));
fs.rmSync(store, { recursive: true, force: true });
check('测试库目录已清理', !fs.existsSync(store), path.relative(projectRoot, store));

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
