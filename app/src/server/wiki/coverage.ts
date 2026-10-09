import { loadCatalog, loadSourceManifest } from './catalog.ts';

/**
 * 收录范围问答（任务书 §4）：数据只来自 `corpus/manifest.jsonl` 与 `wiki/catalog.json` 的**已核验字段**，
 * 由程序生成四个层次，不让模型从本轮 S1/S2 反推全库总数。
 *
 * 四层语义：
 *   1. imported（已导入原件）：manifest 有来源记录 + 包内有原件副本（不等于已提取/读懂）；
 *   2. processed（已提取/清洗）：manifest.processing.status === 'processed' 且有 cleanedPath；
 *   3. wikiIndexed（已编入 Wiki）：catalog.json 里确实有来源页/概念页登记；
 *   4. usedThisTurn（本次使用）：由调用方传入本次实际选中的 sourceId 列表，不在此模块推断。
 */
export interface CoverageCounts {
  imported: number;
  processed: number;
  wikiIndexed: number;
  sourceIds: string[];
  processedIds: string[];
  wikiSourceIds: string[];
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
}

export interface WikiCoverage {
  counts: CoverageCounts;
  files: CoverageFile[];
  /** 供模型受控使用的目录摘要（不含“本次使用”，由本轮计划对象补充） */
  summary: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 从 manifest + catalog 生成真实收录范围；不接触 F 盘，不读原件正文。 */
export function describeWikiCoverage(projectRoot: string): WikiCoverage {
  const manifest = loadSourceManifest(projectRoot);
  const catalog = loadCatalog(projectRoot);

  const wikiSourceIds = new Set<string>();
  for (const page of catalog.pages) {
    for (const sid of page.sourceIds ?? []) wikiSourceIds.add(sid);
  }
  for (const page of catalog.pages) {
    if (page.kind === 'source') wikiSourceIds.add(page.pageId.replace(/^source:/, ''));
  }

  const files: CoverageFile[] = [];
  for (const record of manifest.values()) {
    const processing = record.processing as Record<string, unknown> | undefined;
    const coverage = record.coverage as Record<string, unknown> | undefined;
    const processed = Boolean(processing?.status === 'processed' && processing?.cleanedPath);
    files.push({
      sourceId: str(record.source_id),
      sha256Prefix: str(record.sha256).slice(0, 12),
      relativePathFromF: str(record.sourceRelativePathFromF),
      format: str(record.format),
      quality: str(coverage?.quality) || 'needs_review',
      imported: true,
      processed,
      wikiIndexed: wikiSourceIds.has(str(record.source_id)),
    });
  }

  const counts: CoverageCounts = {
    imported: files.length,
    processed: files.filter((item) => item.processed).length,
    wikiIndexed: files.filter((item) => item.wikiIndexed).length,
    sourceIds: files.map((item) => item.sourceId),
    processedIds: files.filter((item) => item.processed).map((item) => item.sourceId),
    wikiSourceIds: files.filter((item) => item.wikiIndexed).map((item) => item.sourceId),
  };

  const lines = [
    `已导入原件：${counts.imported} 份（含源文件与哈希登记，不等于已提取或已编入）`,
    `已提取/清洗：${counts.processed} 份（有可定位文本，不等于已成为 Wiki 规则）`,
    `已编入 Wiki：${counts.wikiIndexed} 份来源（来源页/概念页中有可定位主张）`,
  ];
  for (const item of files) {
    lines.push(
      `- ${item.sourceId} ${item.relativePathFromF}｜${item.format}｜${item.quality}｜提取=${item.processed ? '是' : '否'}｜编入=${item.wikiIndexed ? '是' : '否'}`,
    );
  }
  const summary = lines.join('\n');
  return { counts, files, summary };
}

/** 用于“某文件收录了吗”的确定性回答：按文件名/来源 ID 子串匹配，返回匹配项或空数组。 */
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
