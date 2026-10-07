/**
 * 浏览器级测试的服务编排（Playwright globalSetup）。
 *
 * 隔离原则：
 *   - 数据库：`storage/tmp/ui-e2e-<pid>` 全新空库（应用自己跑 0001+0002 迁移），**不碰正式库**；
 *   - 上游：本地模拟上游（scripts/mock-upstream.mjs）扮演 DeepSeek 与千问，**不调用真实 API**；
 *   - 口令：用 `LIUYAO_OWNER_PASSWORD`（仅本地隔离测试；正式环境用 scrypt 哈希）；
 *   - 端口：向操作系统申请空闲端口，避免与开发中的 3000/3010 冲突。
 *
 * 关键点：spawn 的 env 会覆盖 app/.env.local —— Next 不覆盖**已存在**的 process.env，
 * 因此这里的 mock 地址与假密钥会生效（真实密钥不会被使用）。
 * 测试通过模拟上游的 /__stats 断言"请求确实走了模拟上游"，可反向证明未打真实 API。
 *
 * 前置：需要先 `npm run build`（这里跑 `next start`）。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// Playwright 把 TS 规格转成 CJS，因此用 __dirname（不能用 import.meta）
const appDir = path.resolve(__dirname, '..');
const projectRoot = path.resolve(appDir, '..');
const runtimeFile = path.join(appDir, 'e2e', '.runtime.json');
const TEST_PASSWORD = 'ui-e2e-password';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待 ${url} 就绪超时：${lastError}`);
}

function stop(child: ChildProcess | null): void {
  if (!child || child.killed) return;
  try {
    child.kill('SIGKILL');
  } catch {
    /* 忽略 */
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const storeDir = path.join(projectRoot, 'storage', 'tmp', `ui-e2e-${process.pid}`);
  fs.rmSync(storeDir, { recursive: true, force: true });
  fs.mkdirSync(storeDir, { recursive: true });

  let mock: ChildProcess | null = null;
  let app: ChildProcess | null = null;

  try {
    // 1) 模拟上游
    mock = spawn(process.execPath, [path.join(appDir, 'scripts', 'mock-upstream.mjs'), '--port', '0'], {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const mockPort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('模拟上游未在 15s 内报告端口')), 15_000);
      let buffer = '';
      mock?.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = /MOCK_UPSTREAM_PORT=(\d+)/.exec(buffer);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      mock?.stderr?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
      });
      mock?.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`模拟上游退出，code=${code}；输出：${buffer.slice(0, 300)}`));
      });
    });
    const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

    // 2) 应用（生产构建 + 隔离库 + 模拟上游）
    const appPort = await freePort();
    // 口令哈希必须显式传入：app/.env.local 里可能已有真实哈希，而 Next 只对"进程 env 未设置"的键
    // 采用 .env.local 的值——显式设置才能保证测试用测试口令、且绝不使用你的真实口令。
    const hashed = spawnSync(process.execPath, [path.join(appDir, 'scripts', 'hash-password.mjs'), TEST_PASSWORD], {
      cwd: appDir,
      encoding: 'utf8',
    });
    const hashMatch = /(scrypt:[^\s"']+)/.exec(`${hashed.stdout ?? ''}${hashed.stderr ?? ''}`);
    if (!hashMatch) {
      throw new Error(`未能生成测试口令哈希：${(hashed.stdout ?? '').slice(0, 200)}${(hashed.stderr ?? '').slice(0, 200)}`);
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LIUYAO_STORAGE_DIR: storeDir,
      LIUYAO_MIGRATIONS_DIR: path.join(appDir, 'migrations'),
      LIUYAO_PROJECT_ROOT: projectRoot,
      LIUYAO_OWNER_USERNAME: 'owner',
      LIUYAO_OWNER_PASSWORD_HASH: hashMatch[1],
      LIUYAO_COOKIE_SECURE: 'false',
      DEEPSEEK_API_KEY: 'mock-deepseek-key',
      LLM_BASE_URL: `${mockBaseUrl}/v1`,
      LLM_MODEL: 'deepseek-flash',
      QWEN_API_KEY: 'mock-qwen-key',
      QWEN_BASE_URL: `${mockBaseUrl}/compatible-mode/v1`,
      QWEN_MODEL: 'qwen3.7-plus',
    };
    delete env.LIUYAO_FAKE_MODEL;
    // 不要删 LIUYAO_OWNER_PASSWORD_HASH：上面刚用测试口令生成（曾经多写一行 delete 导致
    // 应用回落到 app/.env.local 里的真实哈希，登录一直报"密码不正确"）
    delete env.LIUYAO_OWNER_PASSWORD;

    const appLog = path.join(storeDir, 'app.log');
    app = spawn(process.execPath, [path.join(appDir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(appPort)], {
      cwd: appDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logStream = fs.createWriteStream(appLog);
    app.stdout?.pipe(logStream);
    app.stderr?.pipe(logStream);

    const baseUrl = `http://127.0.0.1:${appPort}`;
    try {
      await waitForHttp(`${baseUrl}/login`, 90_000);
    } catch (error) {
      const log = fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8').slice(-2000) : '(无日志)';
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n应用日志：\n${log}`);
    }

    fs.writeFileSync(
      runtimeFile,
      JSON.stringify({ baseUrl, mockBaseUrl, storeDir, password: TEST_PASSWORD, appLog }, null, 2),
      'utf8',
    );
    console.log(`[ui-e2e] 应用 ${baseUrl}；模拟上游 ${mockBaseUrl}；隔离库 ${storeDir}`);
  } catch (error) {
    stop(app);
    stop(mock);
    fs.rmSync(storeDir, { recursive: true, force: true });
    throw error;
  }

  // 测试结束后清理：停服务、删隔离库与运行时文件
  return async () => {
    stop(app);
    stop(mock);
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(runtimeFile, { force: true });
    console.log('[ui-e2e] 已停止服务并清理隔离库');
  };
}
