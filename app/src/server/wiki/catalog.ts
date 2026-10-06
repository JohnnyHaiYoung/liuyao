/**
 * Wiki 目录加载与页面读取（阶段 4）
 *
 * 只依赖 node:*，可由 Next 路由与离线自检脚本共同使用：
 * 这样"目录选页"能在不启动 Next 的情况下被独立验证（避免只在开发机跨目录导入才跑通）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface CatalogPage {
  pageId: string;
  path: string;
  kind: string;
  title: string;
  displayName?: string;
  topics: string[];
  aliases: string[];
  methodLabels: string[];
  sourceIds: string[];
  qualityStatus: 'usable' | 'needs_review';
  qualityRank: number;
  applicableQuestions: string[];
  bytes: number;
  sha256: string;
}

export interface WikiCatalog {
  catalogVersion: string;
  generatedFrom: { indexPath: string; indexSha256: string; note?: string };
  pageCount: number;
  pages: CatalogPage[];
}

export interface WikiRuntimeOptions {
  projectRoot: string;
  maxPages?: number;
  maxChars?: number;
  /** 每段证据摘录上限（字符） */
  maxExcerptChars?: number;
}

export const DEFAULT_MAX_PAGES = 4;
export const DEFAULT_MAX_CHARS = 16_000;
export const DEFAULT_MAX_EXCERPT_CHARS = 1_200;

export function resolveProjectRoot(explicit?: string): string {
  const fromEnv = process.env.LIUYAO_PROJECT_ROOT?.trim();
  if (explicit && explicit.trim() !== '') return path.resolve(explicit.trim());
  if (fromEnv && fromEnv !== '') return path.resolve(fromEnv);
  // app/src/server/wiki → 项目根为上四级（用 fileURLToPath 以避免 Windows 盘符路径解析问题）
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

export function wikiPaths(projectRoot: string): { wikiDir: string; catalogPath: string; corpusDir: string; manifestPath: string } {
  const root = path.resolve(projectRoot);
  return {
    wikiDir: path.join(root, 'wiki'),
    catalogPath: path.join(root, 'wiki', 'catalog.json'),
    corpusDir: path.join(root, 'corpus'),
    manifestPath: path.join(root, 'corpus', 'manifest.jsonl'),
  };
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export class WikiCatalogError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WikiCatalogError';
    this.code = code;
  }
}

/** 载入并校验目录结构（不读页面正文）。 */
export function loadCatalog(projectRoot: string): WikiCatalog {
  const { catalogPath } = wikiPaths(projectRoot);
  if (!fs.existsSync(catalogPath)) {
    throw new WikiCatalogError('catalog_missing', `未找到 ${path.relative(projectRoot, catalogPath)}；请先运行 node app/scripts/build-wiki-catalog.mjs`);
  }
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as WikiCatalog;
  if (catalog.catalogVersion !== 'wiki-catalog.v1') {
    throw new WikiCatalogError('catalog_version_unsupported', `不支持的目录版本：${catalog.catalogVersion}`);
  }
  const seen = new Set<string>();
  for (const page of catalog.pages ?? []) {
    if (seen.has(page.pageId)) throw new WikiCatalogError('catalog_duplicate_page', `目录存在重复 pageId：${page.pageId}`);
    seen.add(page.pageId);
    if (!page.path.startsWith('wiki/') || page.path.includes('..')) {
      throw new WikiCatalogError('catalog_path_invalid', `目录条目路径非法：${page.path}`);
    }
  }
  return catalog;
}

export interface PageReadResult {
  page: CatalogPage;
  text: string;
  /** 磁盘内容与目录登记的哈希是否一致 */
  hashMatches: boolean;
  actualSha256: string;
}

/** 读取页面正文并核对与目录登记的哈希；不一致时明确标记（不静默使用过期目录）。 */
export function readCatalogPage(projectRoot: string, page: CatalogPage): PageReadResult {
  const { wikiDir } = wikiPaths(projectRoot);
  const absolute = path.join(projectRoot, page.path);
  const wikiRoot = path.resolve(wikiDir) + path.sep;
  if (!path.resolve(absolute).startsWith(wikiRoot)) {
    throw new WikiCatalogError('page_outside_wiki', `页面越出 wiki 目录：${page.path}`);
  }
  if (!fs.existsSync(absolute)) {
    throw new WikiCatalogError('page_missing', `目录登记的页面不存在：${page.path}`);
  }
  const text = fs.readFileSync(absolute, 'utf8');
  const actualSha256 = sha256Hex(text);
  return { page, text, hashMatches: actualSha256 === page.sha256, actualSha256 };
}

/** 载入来源清单（corpus/manifest.jsonl），用于把 source_id 映射到原件/清洗文本定位方式。 */
export function loadSourceManifest(projectRoot: string): Map<string, Record<string, unknown>> {
  const { manifestPath } = wikiPaths(projectRoot);
  const map = new Map<string, Record<string, unknown>>();
  if (!fs.existsSync(manifestPath)) return map;
  for (const line of fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const id = record.source_id;
      if (typeof id === 'string') map.set(id, record);
    } catch {
      // 清单行损坏时不静默丢弃语义：由调用方通过 size 差异发现
    }
  }
  return map;
}

/** 白名单：只有清单内（或标签页所在的）来源才能被出处接口读取。 */
export function isKnownSourceId(projectRoot: string, sourceId: string): boolean {
  if (!/^src-[0-9a-f]{12}$/.test(sourceId)) return false;
  return loadSourceManifest(projectRoot).has(sourceId);
}
