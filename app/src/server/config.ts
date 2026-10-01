import fs from 'node:fs';
import path from 'node:path';

/**
 * 运行时配置。所有密钥只从服务器环境变量读取：
 * 不写入代码、浏览器包、数据库或提交内容。
 */

export interface AppConfig {
  projectRoot: string;
  storageDir: string;
  migrationsDir: string;
  databasePath: string;
  backupsDir: string;
  owner: {
    username: string;
    passwordHash: string | null;
    password: string | null;
  };
  session: {
    cookieName: string;
    ttlMs: number;
    /** auto：按请求协议决定 Secure；always/never 用于显式覆盖。 */
    secureMode: 'auto' | 'always' | 'never';
  };
  llm: {
    provider: 'deepseek';
    baseUrl: string;
    model: string;
    apiKey: string | null;
    reasoningEffort: 'none' | 'low' | 'high' | 'max';
    maxOutputTokens: number | null;
    timeoutMs: number;
    /** 本地验收用假模型开关（LIUYAO_FAKE_MODEL=1）；默认关闭。 */
    fakeMode: boolean;
    /** 界面/请求实际使用的模型 ID：假模型模式下为 fake-stream-v1。 */
    activeModelId: string;
  };
  chat: {
    maxMessageChars: number;
    contextMessageLimit: number;
    contextCharBudget: number;
    streamPersistIntervalMs: number;
  };
  limits: {
    loginMaxAttempts: number;
    loginWindowMs: number;
    sendsPerMinute: number;
  };
  appVersion: string;
}

/**
 * 定位项目根目录。
 *
 * 应用代码位于 `<root>/app`，因此：
 *   1. 服务器显式设置 LIUYAO_PROJECT_ROOT 时以它为准（部署推荐）；
 *   2. 否则按当前工作目录推断：在 app/ 里启动 → 上一级；在项目根启动 → 当前目录。
 *
 * 刻意不做文件系统探测：打包器会把动态 fs 访问视为“需要追踪整个项目”。
 * 推断错误时迁移目录会立刻报“找不到迁移目录”，不会静默写错位置。
 */
function detectProjectRoot(): string {
  const override = process.env.LIUYAO_PROJECT_ROOT;
  if (override && override.trim() !== '') {
    return path.resolve(override.trim());
  }
  const cwd = process.cwd();
  if (path.basename(cwd).toLowerCase() === 'app') {
    return path.dirname(cwd);
  }
  return cwd;
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function readFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function readReasoningEffort(): AppConfig['llm']['reasoningEffort'] {
  const raw = (process.env.LLM_REASONING_EFFORT ?? 'high').trim().toLowerCase();
  if (raw === 'none' || raw === 'low' || raw === 'high' || raw === 'max') return raw;
  // 兼容“关闭思考”的常见写法。
  if (raw === 'off' || raw === 'disabled' || raw === 'false') return 'none';
  return 'high';
}

function readSecureMode(): AppConfig['session']['secureMode'] {
  const raw = (process.env.LIUYAO_COOKIE_SECURE ?? 'auto').trim().toLowerCase();
  if (raw === 'always' || raw === '1' || raw === 'true') return 'always';
  if (raw === 'never' || raw === '0' || raw === 'false') return 'never';
  return 'auto';
}

function buildConfig(): AppConfig {
  const projectRoot = detectProjectRoot();
  const storageDir = process.env.LIUYAO_STORAGE_DIR
    ? path.resolve(process.env.LIUYAO_STORAGE_DIR.trim())
    : path.join(projectRoot, 'storage');
  const migrationsDir = process.env.LIUYAO_MIGRATIONS_DIR
    ? path.resolve(process.env.LIUYAO_MIGRATIONS_DIR.trim())
    : path.join(projectRoot, 'app', 'migrations');

  const maxOutputRaw = process.env.LLM_MAX_OUTPUT_TOKENS;
  const maxOutputTokens =
    maxOutputRaw && maxOutputRaw.trim() !== '' ? readInt('LLM_MAX_OUTPUT_TOKENS', 8192, 64, 393216) : null;
  const fakeMode = (process.env.LIUYAO_FAKE_MODEL ?? '').trim() === '1';
  const model = (process.env.LLM_MODEL ?? 'deepseek-flash').trim() || 'deepseek-flash';

  return {
    projectRoot,
    storageDir,
    migrationsDir,
    databasePath: path.join(storageDir, 'liuyao.db'),
    backupsDir: path.join(storageDir, 'backups'),
    owner: {
      username: (process.env.LIUYAO_OWNER_USERNAME ?? 'owner').trim() || 'owner',
      passwordHash: process.env.LIUYAO_OWNER_PASSWORD_HASH?.trim() || null,
      password: process.env.LIUYAO_OWNER_PASSWORD ?? null,
    },
    session: {
      cookieName: process.env.LIUYAO_SESSION_COOKIE ?? 'liuyao_session',
      ttlMs: readInt('LIUYAO_SESSION_TTL_DAYS', 30, 1, 365) * 24 * 60 * 60 * 1000,
      secureMode: readSecureMode(),
    },
    llm: {
      provider: 'deepseek',
      baseUrl: (process.env.LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
      model,
      apiKey: process.env.DEEPSEEK_API_KEY?.trim() || null,
      reasoningEffort: readReasoningEffort(),
      maxOutputTokens,
      timeoutMs: readInt('LLM_TIMEOUT_MS', 180000, 5000, 900000),
      fakeMode,
      activeModelId: fakeMode ? 'fake-stream-v1' : model,
    },
    chat: {
      maxMessageChars: readInt('LIUYAO_MAX_MESSAGE_CHARS', 8000, 1, 100000),
      contextMessageLimit: readInt('LIUYAO_CONTEXT_MESSAGE_LIMIT', 20, 1, 200),
      contextCharBudget: readInt('LIUYAO_CONTEXT_CHAR_BUDGET', 40000, 500, 1000000),
      streamPersistIntervalMs: readInt('LIUYAO_STREAM_PERSIST_INTERVAL_MS', 1000, 200, 30000),
    },
    limits: {
      loginMaxAttempts: readInt('LIUYAO_LOGIN_MAX_ATTEMPTS', 10, 1, 1000),
      loginWindowMs: readFloat('LIUYAO_LOGIN_WINDOW_MINUTES', 15, 0.1, 1440) * 60 * 1000,
      sendsPerMinute: readInt('LIUYAO_SENDS_PER_MINUTE', 30, 1, 600),
    },
    appVersion: '0.1.0-phase1',
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) {
    cached = buildConfig();
  }
  return cached;
}

export function isLlmConfigured(): boolean {
  const config = getConfig();
  if (config.llm.fakeMode) return true;
  const { apiKey } = config.llm;
  return typeof apiKey === 'string' && apiKey.length > 0;
}

export function isOwnerConfigured(): boolean {
  const { passwordHash, password } = getConfig().owner;
  return Boolean(passwordHash || password);
}

/** 确保 storage/ 与 backups/ 存在；运行时数据不放进只读知识目录。 */
export function ensureStorageDirs(): void {
  const { storageDir, backupsDir } = getConfig();
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });
}
