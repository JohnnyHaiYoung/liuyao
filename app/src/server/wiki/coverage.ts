import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadCatalog, loadSourceManifest, wikiPaths } from './catalog.ts';

/**
 * 收录范围问答（任务书 §4 / 复验 P2-1）：数据只来自 manifest + catalog 的**已核验字段与磁盘事实**，
 * 由程序生成四层，不让模型从本轮 S1/S2 反推全库总数。
 *
 * 四层语义（复验 P2-1 起按磁盘事实与质量分档，不再只按元数据字段计数）：
 *   1. imported（已导入原件）：manifest 有记录，且 corpus/originals 下原件**存在且哈希与清单一致**；
 *   2. processed（已提取/清洗）：corpus/cleaned 下清洗文本**存在**；
 *   3. wikiIndexed（已编入 Wiki）：catalog 有来源页登记且来源页文件**存在**；
 *   4. citable（已核对可引用规则）：wikiIndexed 且质量非 `needs_review`（即来源页有已核对范围）。
 */
export interface CoverageCounts {
  imported: number;
  processed: number;
  wikiIndexed: number;
  citable: number;
  sourceIds: string[];
  citableIds: string[];
}

export interface CoverageFile {
  sourceId: string;
  sha256Prefix: string;
  relativePathFromF: string;
  format: string;
  quality: string;
  imported: boolean;
  processed: boolean;
  wikiIndexed: boolean;
  citable: boolean;
}

export interface WikiCoverage {
  counts: CoverageCounts;
  files: CoverageFile[];
  summary: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function fileExists(p: string): boolean {
  return typeof p === 'string' && p !== '' && existsSync(p);
}

function sha256File(p: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

export function describeWikiCoverage(projectRoot: string): WikiCoverage {
  const manifest = loadSourceManifest(projectRoot);
  const catalog = loadCatalog(projectRoot);

  const wikiSourceIds = new Set<string>();
  for (const page of catalog.pages) {
    for (const sid of page.sourceIds ?? []) wikiSourceIds.add(sid);
    if (page.kind === 'source') wikiSourceIds.add(page.pageId.replace(/^source:/, ''));
  }

  const files: CoverageFile[] = [];
  for (const record of manifest.values()) {
    const sourceId = str(record.source_id);
    const processing = record.processing as Record<string, unknown> | undefined;
    const coverage = record.coverage as Record<string, unknown> | undefined;
    const originalRelative = str(record.originalRelativePath);
    const cleanedPath = str(processing?.cleanedPath);
    const quality = str(coverage?.quality) || 'needs_review';

    const originalAbs = join(projectRoot, originalRelative);
    const hashMatches = fileExists(originalAbs) && sha256File(originalAbs) === str(record.sha256);
    const processed = fileExists(join(projectRoot, cleanedPath));

    const sourcePage = catalog.pages.find((page) => page.kind === 'source' && page.pageId === `source:${sourceId}`);
    const wikiIndexed = Boolean(sourcePage && fileExists(join(projectRoot, sourcePage.path)));
    const citable = wikiIndexed && quality !== 'needs_review';

    files.push({
      sourceId,
      sha256Prefix: str(record.sha256).slice(0, 12),
      relativePathFromF: str(record.sourceRelativePathFromF),
      format: str(record.format),
      quality,
      imported: hashMatches,
      processed,
      wikiIndexed,
      citable,
    });
  }

  const counts: CoverageCounts = {
    imported: files.filter((item) => item.imported).length,
    processed: files.filter((item) => item.processed).length,
    wikiIndexed: files.filter((item) => item.wikiIndexed).length,
    citable: files.filter((item) => item.citable).length,
    sourceIds: files.filter((item) => item.imported).map((item) => item.sourceId),
    citableIds: files.filter((item) => item.citable).map((item) => item.sourceId),
  };

  const lines = [
    `已导入原件：${counts.imported} 份（原件存在且哈希与清单一致，不等于已提取或已编入）`,
    `已提取/清洗：${counts.processed} 份（有可定位文本，不等于已成 Wiki 规则）`,
    `已编入 Wiki：${counts.wikiIndexed} 份来源（来源页/目录登记，含仅登记章节目录的长讲义）`,
    `其中已核对可引用规则：${counts.citable} 份（质量非 needs_review）`,
  ];
  for (const item of files) {
    lines.push(
      `- ${item.sourceId} ${item.relativePathFromF}｜${item.format}｜${item.quality}｜原件=${item.imported ? '是' : '否'}｜提取=${item.processed ? '是' : '否'}｜编入=${item.wikiIndexed ? '是' : '否'}｜可引用=${item.citable ? '是' : '否'}`,
    );
  }
  const summary = lines.join('\n');
  void wikiSourceIds;
  return { counts, files, summary };
}

/** 具体文件查询：按文件名/来源 ID/哈希前缀子串匹配。 */
export function findCoverageFiles(projectRoot: string, query: string): CoverageFile[] {
  const coverage = describeWikiCoverage(projectRoot);
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  return coverage.files.filter(
    (item) =>
      item.sourceId.toLowerCase().includes(q) ||
      item.relativePathFromF.toLowerCase().includes(q) ||
      item.sha256Prefix.includes(q),
  );
}

/** 主题查询：按标题/别名/主题词在目录中匹配页面及其来源（用于"有没有关于X的资料"）。 */
export function searchCoverageByTopic(
  projectRoot: string,
  topic: string,
): Array<{ pageId: string; title: string; kind: string; sourceIds: string[] }> {
  const catalog = loadCatalog(projectRoot);
  const q = topic.trim().toLowerCase();
  if (q === '') return [];
  return catalog.pages
    .filter((page) => {
      const hay = [page.title ?? '', page.displayName ?? '', ...(page.aliases ?? []), ...(page.topics ?? [])]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    })
    .map((page) => ({
      pageId: page.pageId,
      title: page.displayName ?? page.title ?? page.pageId,
      kind: page.kind,
      sourceIds: page.sourceIds ?? [],
    }));
}
