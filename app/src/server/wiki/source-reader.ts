/**
 * 来源读取与出处解析（阶段 4 任务书第 3.6、7.2 节）
 *
 * 安全边界（全部在该模块实现，路由只做薄封装，便于离线复验）：
 *   - 只有 corpus/manifest.jsonl 白名单内的 source_id 可读；
 *   - 定位只接受 `¶NNNN` 段落锚点与「第 N 页/J页」页码，不接受任意路径或行号；
 *   - 页图只接受 `corpus/assets/<sourceId>/page-NNN.jpg` 这一种形态，扩展名与命名严格白名单；
 *   - 一律拒绝绝对路径、`..`、URL 编码绕过、目录分隔符注入、未知 ID 与非白名单扩展名。
 *
 * 只依赖 node:*：Next 路由与离线自检脚本共用同一实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSourceManifest, sha256Hex, wikiPaths, type CatalogPage, type WikiCatalog } from './catalog.ts';

export class SourceAccessError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SourceAccessError';
    this.code = code;
  }
}

const SOURCE_ID_PATTERN = /^src-[0-9a-f]{12}$/;
const ASSET_NAME_PATTERN = /^page-\d{3}\.jpg$/;
const PARAGRAPH_PATTERN = /^¶(\d{4})$/;
const PAGE_PATTERN = /^(?:第\s*(\d{1,3})\s*页|[Pp]age[:\s]*(\d{1,3}))$/;

export interface SourcePageInfo {
  sourceId: string;
  wikiPath: string;
  qualityStatus: 'usable' | 'needs_review';
  format: string | null;
  cleanedPath: string | null;
  cleanedAvailable: boolean;
  paragraphCount: number;
  assets: { name: string; page: number; bytes: number }[];
  transcriptions: { page: number; wikiOrCorpusPath: string }[];
}

function assertSourceId(sourceId: string): void {
  if (typeof sourceId !== 'string' || !SOURCE_ID_PATTERN.test(sourceId)) {
    throw new SourceAccessError('invalid_source_id', `来源 ID 形如 src-<12 位十六进制>；收到「${String(sourceId).slice(0, 40)}」`);
  }
}

/** 断言解析后的绝对路径确实位于给定根目录内（防 `..`、符号链接越界与盘符注入）。 */
function assertInside(rootDir: string, candidate: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(candidate);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new SourceAccessError('path_outside_root', '解析后的路径越出允许目录');
  }
  // 符号链接越界检查（realpath 可能因不存在而失败，此时按字面判断已经足够严格）
  try {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(root);
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (real !== realRoot && !real.startsWith(realRootWithSep)) {
      throw new SourceAccessError('symlink_escape', '符号链接指向允许目录之外');
    }
    return real;
  } catch (error) {
    if (error instanceof SourceAccessError) throw error;
    return resolved;
  }
}

export function requireKnownSource(projectRoot: string, sourceId: string): Record<string, unknown> {
  assertSourceId(sourceId);
  const manifest = loadSourceManifest(projectRoot);
  const record = manifest.get(sourceId);
  if (!record) throw new SourceAccessError('unknown_source', `来源不在 corpus/manifest.jsonl 白名单内：${sourceId}`);
  return record;
}

function cleanedFilePath(projectRoot: string, sourceId: string): { absolute: string; relative: string } {
  const { corpusDir } = wikiPaths(projectRoot);
  const absolute = path.join(corpusDir, 'cleaned', `${sourceId}.md`);
  return { absolute: assertInside(path.join(corpusDir, 'cleaned'), absolute), relative: `corpus/cleaned/${sourceId}.md` };
}

function assetsDir(projectRoot: string, sourceId: string): string {
  const { corpusDir } = wikiPaths(projectRoot);
  return assertInside(path.join(corpusDir, 'assets'), path.join(corpusDir, 'assets', sourceId));
}

function transcriptionsDir(projectRoot: string, sourceId: string): string {
  const { corpusDir } = wikiPaths(projectRoot);
  return assertInside(path.join(corpusDir, 'figures'), path.join(corpusDir, 'figures', sourceId));
}

/** 解析 `¶NNNN`：返回段落正文与其所属 PDF 实际页码（清洗文本用 `## 第 N 页（PDF 实际页码）` 分节）。 */
export function readParagraph(projectRoot: string, sourceId: string, paragraph: string): { paragraph: string; text: string; pageNumber: number | null; cleanedPath: string; cleanedSha256: string } {
  requireKnownSource(projectRoot, sourceId);
  const match = PARAGRAPH_PATTERN.exec(paragraph.trim());
  if (!match) throw new SourceAccessError('invalid_locator', `段落定位应形如 ¶0002；收到「${String(paragraph).slice(0, 40)}」`);
  const wanted = match[1]!;
  const { absolute, relative } = cleanedFilePath(projectRoot, sourceId);
  if (!fs.existsSync(absolute)) throw new SourceAccessError('cleaned_missing', `缺少清洗文本：${relative}`);
  const text = fs.readFileSync(absolute, 'utf8');
  const sections = text.split(/<!--\s*¶(\d{4})[^>]*-->/);
  // split 结果形如 [前言, 段落号, 段落正文, 段落号, 段落正文, …]
  let found: { body: string; pageNumber: number | null } | null = null;
  let cursorPage: number | null = null;
  for (let index = 0; index < sections.length; index += 1) {
    const chunk = sections[index] ?? '';
    const pageHeading = /^##\s*第\s*(\d+)\s*页/m.exec(chunk);
    if (pageHeading) cursorPage = Number.parseInt(pageHeading[1]!, 10);
    if (index > 0 && index % 2 === 1 && chunk === wanted) {
      const body = sections[index + 1] ?? '';
      found = { body, pageNumber: cursorPage };
      break;
    }
  }
  if (!found) throw new SourceAccessError('locator_not_found', `清洗文本中不存在段落 ¶${wanted}（${relative}）`);
  const cleaned = found.body.trim();
  const truncated = cleaned.length > 4000 ? `${cleaned.slice(0, 4000)}\n…（本段更长，已截断）` : cleaned;
  return { paragraph: `¶${wanted}`, text: truncated, pageNumber: found.pageNumber, cleanedPath: relative, cleanedSha256: sha256Hex(text) };
}

/** 解析页码定位：返回该页的页图与（若有）逐页转写文件。 */
export function readPage(projectRoot: string, sourceId: string, pageLocator: string): { page: number; assetPath: string | null; assetAvailable: boolean; transcriptionPath: string | null } {
  requireKnownSource(projectRoot, sourceId);
  const match = PAGE_PATTERN.exec(pageLocator.trim());
  if (!match) throw new SourceAccessError('invalid_locator', `页码定位应形如「第 3 页」或 page:3；收到「${String(pageLocator).slice(0, 40)}」`);
  const page = Number.parseInt((match[1] ?? match[2])!, 10);
  if (!Number.isFinite(page) || page < 1 || page > 999) throw new SourceAccessError('invalid_locator', `页码超出允许范围：${pageLocator}`);
  const name = `page-${String(page).padStart(3, '0')}.jpg`;
  const assetCandidate = path.join(assetsDir(projectRoot, sourceId), name);
  const assetAvailable = fs.existsSync(assetCandidate) && ASSET_NAME_PATTERN.test(name);
  const transcriptionCandidate = path.join(transcriptionsDir(projectRoot, sourceId), `page-${String(page).padStart(3, '0')}.md`);
  const transcriptionPath = fs.existsSync(transcriptionCandidate) ? `corpus/figures/${sourceId}/page-${String(page).padStart(3, '0')}.md` : null;
  return {
    page,
    assetPath: assetAvailable ? `corpus/assets/${sourceId}/${name}` : null,
    assetAvailable,
    transcriptionPath,
  };
}

/** 受控页图解析：只允许 `<sourceId>/page-NNN.jpg`。 */
export function resolveAsset(projectRoot: string, sourceId: string, assetName: string): { absolutePath: string; contentType: string; bytes: number; relativePath: string } {
  requireKnownSource(projectRoot, sourceId);
  if (typeof assetName !== 'string' || decodeURIComponent(assetName) !== assetName) {
    throw new SourceAccessError('invalid_asset', '页图名不得包含 URL 编码');
  }
  if (!ASSET_NAME_PATTERN.test(assetName)) {
    throw new SourceAccessError('invalid_asset', `页图名只允许 page-NNN.jpg；收到「${assetName.slice(0, 40)}」`);
  }
  const dir = assetsDir(projectRoot, sourceId);
  const candidate = assertInside(dir, path.join(dir, assetName));
  if (!fs.existsSync(candidate)) throw new SourceAccessError('asset_not_found', `页图不存在：${sourceId}/${assetName}`);
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) throw new SourceAccessError('asset_not_found', '页图路径不是文件');
  return { absolutePath: candidate, contentType: 'image/jpeg', bytes: stat.size, relativePath: `corpus/assets/${sourceId}/${assetName}` };
}

/** 汇总某来源的可展示信息（供登录后的出处页使用）。 */
export function describeSource(projectRoot: string, sourceId: string, catalog: WikiCatalog): SourcePageInfo {
  const record = requireKnownSource(projectRoot, sourceId);
  const wikiPage: CatalogPage | undefined = catalog.pages.find((page) => page.pageId === `source:${sourceId}`);
  const { absolute } = cleanedFilePath(projectRoot, sourceId);
  let paragraphCount = 0;
  if (fs.existsSync(absolute)) {
    paragraphCount = [...fs.readFileSync(absolute, 'utf8').matchAll(/<!--\s*¶(\d{4})[^>]*-->/g)].length;
  }
  const dir = assetsDir(projectRoot, sourceId);
  const assets = fs.existsSync(dir)
    ? fs.readdirSync(dir)
        .filter((name) => ASSET_NAME_PATTERN.test(name))
        .map((name) => ({ name, page: Number.parseInt(name.slice(5, 8), 10), bytes: fs.statSync(path.join(dir, name)).size }))
        .sort((a, b) => a.page - b.page)
    : [];
  const tDir = transcriptionsDir(projectRoot, sourceId);
  const transcriptions = fs.existsSync(tDir)
    ? fs.readdirSync(tDir)
        .filter((name) => /^page-\d{3}\.md$/.test(name))
        .map((name) => ({ page: Number.parseInt(name.slice(5, 8), 10), wikiOrCorpusPath: `corpus/figures/${sourceId}/${name}` }))
        .sort((a, b) => a.page - b.page)
    : [];
  return {
    sourceId,
    wikiPath: wikiPage?.path ?? `wiki/sources/${sourceId}.md`,
    qualityStatus: wikiPage?.qualityStatus ?? 'usable',
    format: typeof record.format === 'string' ? record.format : null,
    cleanedPath: fs.existsSync(absolute) ? `corpus/cleaned/${sourceId}.md` : null,
    cleanedAvailable: fs.existsSync(absolute),
    paragraphCount,
    assets,
    transcriptions,
  };
}
