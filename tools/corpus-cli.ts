/**
 * corpus-cli — 第二阶段资料处理命令行。
 *
 * 用法（在项目根目录执行；Node 22 可直接运行 .ts）：
 *   node tools/corpus-cli.ts import                 # 从 F 盘只读复制样本，校验哈希并登记
 *   node tools/corpus-cli.ts extract --all          # 按格式提取到 corpus/extracted
 *   node tools/corpus-cli.ts ocr --source <id> --pages 1-5
 *   node tools/corpus-cli.ts clean --all            # 生成 corpus/cleaned/*.md
 *   node tools/corpus-cli.ts report --all           # 生成 corpus/reports/<id>.md
 *   node tools/corpus-cli.ts verify                 # 校验哈希、链接、定位与 F 盘未变
 *   node tools/corpus-cli.ts status                 # 汇总
 *
 * 设计约束：
 *   - 只用 Node 内置模块（本机无 pip / LibreOffice / poppler / tesseract）。
 *   - 原文只读：仅从 F 盘复制到 corpus/originals，复制前后核对 SHA-256。
 *   - 所有写入路径都是项目相对路径；F 盘绝对路径只出现在 manifest 的审计字段里。
 *   - 需要 Windows 内建 PDF 渲染 / OCR 的步骤通过 tools/offline/*.ps1 完成，
 *     命令行只传文件路径并读取它们写出的 JSON 元数据（不依赖管道，便于在受限沙箱下运行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assetsDir,
  cleanedDir,
  collapseCjkSpaces,
  corpusDir,
  decodeTextBuffer,
  ensureDir,
  extractedDir,
  findParagraphIndex,
  fromProjectRelative,
  isoTimestampCompact,
  manifestPath,
  normalizeFullWidthSpaces,
  normalizeNewlines,
  nowIso,
  originalsDir,
  projectRoot,
  readManifest,
  relativeToProject,
  reportsDir,
  sha256File,
  sourceDriveRoot,
  splitParagraphs,
  stableId,
  storageDir,
  textStats,
  toPosix,
  toolsDir,
  upsertManifest,
  writeManifest,
  type ManifestSource,
} from './lib/common.ts';
import { readDocx, readLegacyDoc, readZip } from './lib/office.ts';
import { readPdf } from './lib/pdf.ts';
import { createZip } from './lib/zip.ts';

interface SampleDefinition {
  role: string;
  path: string;
  format: 'txt' | 'docx' | 'doc' | 'pdf' | 'pdf-scan';
  expectedEncoding?: string;
  purpose: string;
}

interface SampleSet {
  version: string;
  sourceRoot: string;
  samples: SampleDefinition[];
  deferred: Array<{ path: string; reason: string }>;
}

const sampleSetPath = path.join(toolsDir, 'sample-set.json');
const workDir = path.join(storageDir, 'work');
const OCR_SCRIPT = path.join(toolsDir, 'offline', 'ocr-image.ps1');
const RENDER_SCRIPT = path.join(toolsDir, 'offline', 'pdf-render.ps1');
const DOWNSCALE_SCRIPT = path.join(toolsDir, 'offline', 'image-downscale.ps1');

/**
 * Render PDF pages and store them as bounded-width JPEG assets.
 * Assets are the page evidence referenced by Wiki pages; the full-resolution PNG stays in
 * storage/work (excluded from the package) so the corpus stays small.
 */
function buildPageAssets(source: ManifestSource, pages: string): { assets: string[]; rendered: Array<{ page: number; pixels: string }> } {
  const original = fromProjectRelative(source.originalRelativePath);
  const work = path.join(workDir, source.source_id, `assets-${pages.replace(/[^0-9-]/g, '')}`);
  ensureDir(work);
  const renderDir = path.join(work, 'pages');
  const renderMetaPath = path.join(work, 'render-meta.json');
  runPowerShell(RENDER_SCRIPT, [
    '-PdfPath', original,
    '-OutDir', renderDir,
    '-Pages', pages,
    '-Scale', '1',
    '-OutMeta', renderMetaPath,
  ]);
  const renderMeta = readJsonFile<{ rendered: Array<{ page: number; file: string; pixels: string }> }>(renderMetaPath);
  const assets: string[] = [];
  for (const rendered of renderMeta.rendered) {
    const target = path.join(assetsDir, source.source_id, `page-${String(rendered.page).padStart(3, '0')}.jpg`);
    runPowerShell(DOWNSCALE_SCRIPT, [
      '-InputPath', path.join(renderDir, rendered.file),
      '-OutputPath', target,
      '-MaxWidth', '1400',
      '-Quality', '82',
    ]);
    assets.push(relativeToProject(target));
  }
  return { assets, rendered: renderMeta.rendered };
}

function readSampleSet(): SampleSet {
  // 默认使用 tools/sample-set.json；--sample-set <file> 用于隔离样本集的复验（例如同哈希/空文件场景）。
  const index = process.argv.indexOf('--sample-set');
  const file = index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : sampleSetPath;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SampleSet;
}
function sourceIdForSha(sha256: string): string {
  // 与既有试点 ID 规则一致（src- + sha256 前 12 位）；碰撞时由 manifest 检查提示扩位。
  return `src-${sha256.slice(0, 12)}`;
}
function findSource(id: string): ManifestSource {
  const source = readManifest().find((item) => item.source_id === id);
  if (!source) throw new Error(`manifest 中没有来源 ${id}；先执行 import`);
  return source;
}
function selectedSources(options: Map<string, string[]>): ManifestSource[] {
  const all = readManifest();
  if (options.has('all')) return all;
  const ids = options.get('source') ?? [];
  if (ids.length === 0) throw new Error('需要 --all 或 --source <source_id>');
  return ids.map((id) => findSource(id));
}
function parseOptions(argv: string[]): { command: string; options: Map<string, string[]> } {
  const [command = 'status', ...rest] = argv;
  const options = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options.set(name, []);
    } else {
      const list = options.get(name) ?? [];
      list.push(next);
      options.set(name, list);
      index += 1;
    }
  }
  return { command, options };
}
function runPowerShell(script: string, args: string[]): void {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`PowerShell 脚本失败（exit ${result.status}）：${path.basename(script)}`);
}
function readJsonFile<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
function writeText(file: string, content: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, 'utf8');
}

/**
 * Replace a machine-generated note instead of appending it again.
 * Keeping this idempotent matters: the processing commands are meant to be re-runnable.
 */
function replaceNote(source: ManifestSource, prefix: string, text: string): void {
  source.notes = source.notes.filter((note) => !note.startsWith(prefix));
  source.notes.push(text);
}

/** 角色标签（来源页/status 使用），从「角色：X；用途：…」中取出 X。 */
function sourceRole(source: ManifestSource): string {
  const note = source.notes.find((item) => item.startsWith('角色：'));
  if (!note) return source.format;
  return note.slice('角色：'.length).split('；')[0] ?? source.format;
}
function titleFromPath(relativePath: string): string {
  return path.basename(relativePath).replace(/\.[^.]+$/, '').replace(/[._\s]+$/g, '').trim();
}

/* ------------------------------------------------------------------ import */

function commandImport(): void {
  const set = readSampleSet();
  const existing = readManifest();
  const byHash = new Map(existing.map((item) => [item.sha256, item]));
  const imported: string[] = [];

  for (const sample of set.samples) {
    const sourcePath = path.join(set.sourceRoot, sample.path);
    if (!fs.existsSync(sourcePath)) {
      console.error(`  跳过（F 盘不存在）：${sample.path}`);
      continue;
    }
    const sourceSha = sha256File(sourcePath);
    const sizeBytes = fs.statSync(sourcePath).size;
    const sourceId = sourceIdForSha(sourceSha);
    const originalRelative = toPosix(path.join('corpus', 'originals', sample.path));
    const originalAbsolute = fromProjectRelative(originalRelative);

    const collision = existing.find((item) => item.source_id === sourceId && item.sha256 !== sourceSha);
    if (collision) throw new Error(`source_id 碰撞：${sourceId} 已被 ${collision.sourceRelativePathFromF} 占用，需要扩位`);

    ensureDir(path.dirname(originalAbsolute));
    const duplicate = byHash.get(sourceSha) ?? existing.find((item) => item.source_id === sourceId);
    const isAlias = Boolean(duplicate) && duplicate!.sourceRelativePathFromF !== sample.path;
    const aliases = new Set(duplicate?.aliasSourcePaths ?? []);
    if (isAlias) aliases.add(sample.path);

    if (!isAlias) {
      // 首次出现的路径才复制原件；同哈希的其它路径只登记为别名（哈希相同，无需重复占空间）。
      if (!fs.existsSync(originalAbsolute) || sha256File(originalAbsolute) !== sourceSha) {
        fs.copyFileSync(sourcePath, originalAbsolute);
      }
      const copySha = sha256File(originalAbsolute);
      if (copySha !== sourceSha) throw new Error(`复制后哈希不一致：${sample.path}`);
    }

    const prior = duplicate && !isAlias ? undefined : duplicate;
    const entry: ManifestSource = {
      source_id: sourceId,
      sha256: sourceSha,
      sizeBytes,
      format: sample.format,
      extension: path.extname(sample.path).toLowerCase(),
      discoveredAt: duplicate?.discoveredAt ?? nowIso(),
      // 主路径固定为首次导入的路径；后续同哈希路径进入 aliasSourcePaths，不丢失。
      sourceRelativePathFromF: duplicate?.sourceRelativePathFromF ?? sample.path,
      originalRelativePath: duplicate?.originalRelativePath ?? originalRelative,
      aliasSourcePaths: [...aliases].sort(),
      duplicateOf: null,
      suspectedVersionRelation: null,
      processing:
        duplicate?.processing ?? {
          status: 'pending',
          inputEncoding: sample.expectedEncoding ?? null,
          extractor: null,
          extractorVersion: null,
          ocrLanguage: null,
          processedAt: null,
          extractedPath: null,
          cleanedPath: null,
          assetPaths: [],
          tools: [],
        },
      coverage: duplicate?.coverage ?? {
        structureSummary: '',
        totalUnits: '',
        processedUnits: '',
        unprocessedUnits: null,
        quality: 'needs_review',
        issues: [],
      },
      notes: (duplicate?.notes ?? []).filter((note) => note.startsWith('角色：')),
    };
    if (!entry.notes.some((note) => note.startsWith('角色：'))) {
      entry.notes.unshift(`角色：${sample.role}；用途：${sample.purpose}`);
    }
    if (isAlias && !entry.notes.some((note) => note.includes(sample.path))) {
      entry.notes.push(`别名路径（同哈希，未重复复制原件）：${sample.path}`);
    }
    if (prior === undefined && isAlias) {
      entry.notes.push(`别名路径（同哈希，未重复复制原件）：${sample.path}`);
    }
    upsertManifest(entry);
    // 关键：循环内实时更新哈希索引，否则同批次的第二条同哈希路径会覆盖第一条。
    byHash.set(sourceSha, entry);
    imported.push(`${sourceId}  ${sample.role.padEnd(11)}  ${sample.path}${isAlias ? '（同哈希别名）' : ''}`);
  }

  // 同名/近名但哈希不同的文件，仅登记为“待核实版本关系”，不合并。
  const manifest = readManifest();
  const groups = new Map<string, ManifestSource[]>();
  for (const item of manifest) {
    const base = path.basename(item.sourceRelativePathFromF, path.extname(item.sourceRelativePathFromF)).replace(/[\s.]+$/g, '');
    const list = groups.get(base) ?? [];
    list.push(item);
    groups.set(base, list);
  }
  for (const [base, list] of groups) {
    if (list.length > 1 && new Set(list.map((item) => item.sha256)).size > 1) {
      for (const item of list) {
        item.suspectedVersionRelation = `文件名同为「${base}」但哈希不同：${list.map((other) => other.source_id).join(', ')}（待核实是否同书不同版本）`;
        upsertManifest(item);
      }
    }
  }

  console.log(`导入完成：${imported.length} 份`);
  for (const line of imported) console.log(`  ${line}`);
  console.log(`manifest：${relativeToProject(manifestPath)}`);
}

/* ------------------------------------------------------------------ extract */

interface ExtractOutcome {
  text: string;
  encoding: string | null;
  extractor: string;
  extractorVersion: string;
  structure: string;
  totalUnits: string;
  processedUnits: string;
  unprocessed: string | null;
  issues: string[];
  quality: 'usable' | 'needs_review' | 'failed';
  assets: string[];
  paragraphs: string[];
  pageTexts?: Array<{ page: number; text: string }>;
}

function extractTxt(source: ManifestSource): ExtractOutcome {
  const buffer = fs.readFileSync(fromProjectRelative(source.originalRelativePath));
  const decoded = decodeTextBuffer(buffer);
  const text = normalizeNewlines(decoded.text);
  const paragraphs = splitParagraphs(text);
  const issues: string[] = [];
  if (decoded.replacementChars > 0) issues.push(`解码出现 ${decoded.replacementChars} 个替换字符（U+FFFD）`);
  const candidateList = decoded.candidates.map((item) => `${item.encoding}(替换 ${item.replacementChars}, 控制字符 ${item.controlChars})`).join('；');
  return {
    text,
    encoding: decoded.encoding,
    extractor: 'tools/lib/common.ts decodeTextBuffer (TextDecoder)',
    extractorVersion: `node ${process.version}`,
    structure: `纯文本；解码候选：${candidateList}；置信度 ${decoded.confidence}`,
    totalUnits: `${paragraphs.length} 段（按空行/换行切分）`,
    processedUnits: '全文',
    unprocessed: null,
    issues,
    quality: decoded.replacementChars === 0 ? 'usable' : 'needs_review',
    assets: [],
    paragraphs,
  };
}

function extractDocx(source: ManifestSource): ExtractOutcome {
  const buffer = fs.readFileSync(fromProjectRelative(source.originalRelativePath));
  const document = readDocx(buffer);
  const issues: string[] = [];
  const lines: string[] = [];
  for (const block of document.blocks) {
    if (block.kind === 'table') {
      lines.push('[表格]');
      for (const row of block.rows ?? []) lines.push(row.join(' | '));
      lines.push('[/表格]');
    } else {
      lines.push(block.text);
    }
  }
  const text = lines.join('\n\n');
  const paragraphs = splitParagraphs(text);
  const assetPaths: string[] = [];
  if (document.mediaFiles.length > 0) {
    for (const media of document.mediaFiles) {
      const target = path.join(assetsDir, source.source_id, media.name);
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, media.content);
      assetPaths.push(relativeToProject(target));
    }
  } else {
    issues.push('DOCX 内未发现 word/media 图片');
  }
  if (document.tableCount === 0) issues.push('未解析到表格（可能本来就没有）');
  return {
    text,
    encoding: 'utf-8（OOXML）',
    extractor: 'tools/lib/office.ts readDocx（自实现 OOXML 读取：ZIP+document.xml）',
    extractorVersion: `node ${process.version}`,
    structure: `段落 ${document.paragraphCount} 个、表格 ${document.tableCount} 个、图片 ${document.mediaFiles.length} 个`,
    totalUnits: `${paragraphs.length} 个文本块`,
    processedUnits: '全文',
    unprocessed: null,
    issues,
    quality: 'usable',
    assets: assetPaths,
    paragraphs,
  };
}

function extractDoc(source: ManifestSource): ExtractOutcome {
  const buffer = fs.readFileSync(fromProjectRelative(source.originalRelativePath));
  const result = readLegacyDoc(buffer);
  const text = normalizeNewlines(result.text);
  const paragraphs = splitParagraphs(text);
  const issues: string[] = [];
  if (result.pieceCount === 0) issues.push('未解析到分片表（piece table），使用 fcMin..fcMac 回退，可能丢失格式信息');
  return {
    text,
    encoding: result.textEncoding,
    extractor: 'tools/lib/office.ts readLegacyDoc（自实现 MS-DOC：OLE2 + FIB + 分片表）',
    extractorVersion: `node ${process.version}`,
    structure: `nFib=${result.nFib}；表流=${result.tableStream}；分片=${result.pieceCount}；编码=${result.textEncoding}`,
    totalUnits: `${paragraphs.length} 段（按换行切分）`,
    processedUnits: '全文',
    unprocessed: null,
    issues,
    quality: result.pieceCount > 0 ? 'usable' : 'needs_review',
    assets: [],
    paragraphs,
  };
}

function extractPdfText(source: ManifestSource): ExtractOutcome {
  const buffer = fs.readFileSync(fromProjectRelative(source.originalRelativePath));
  const document = readPdf(buffer);
  const pageTexts = document.pages.map((page) => ({ page: page.index, text: normalizeNewlines(page.text) }));
  const issues: string[] = [...document.notes];
  for (const page of document.pages) {
    for (const error of page.errors) issues.push(`第 ${page.index} 页：${error}`);
  }
  const emptyPages = document.pages.filter((page) => !page.hasTextLayer).map((page) => page.index);
  if (emptyPages.length > 0) issues.push(`以下页没有文字层（未收录）：${emptyPages.join(', ')}`);
  const text = pageTexts.map((page) => `===== PDF 第 ${page.page} 页 =====\n${page.text}`).join('\n');
  const fontSummary = document.fonts.map((font) => `${font.name}:${font.subtype ?? '?'}${font.hasToUnicode ? '+ToUnicode' : ''}`).join(' ');
  return {
    text,
    encoding: 'pdf 文字层（toUnicode）',
    extractor: 'tools/lib/pdf.ts readPdf（自实现 PDF 对象/内容流/ToUnicode 解析）',
    extractorVersion: `node ${process.version}`,
    structure: `PDF ${document.version}；页数 ${document.pageCount}；字体：${fontSummary}`,
    totalUnits: `${document.pageCount} 页`,
    processedUnits: `${document.pageCount} 页（有文字层 ${document.pageCount - emptyPages.length} 页）`,
    unprocessed: emptyPages.length > 0 ? `${emptyPages.length} 页无文字层` : null,
    issues,
    quality: emptyPages.length === 0 ? 'usable' : 'needs_review',
    assets: [],
    paragraphs: splitParagraphs(text),
    pageTexts,
  };
}

function commandExtract(options: Map<string, string[]>): void {
  const failures: string[] = [];
  for (const source of selectedSources(options)) {
    const absolute = fromProjectRelative(source.originalRelativePath);
    let outcome: ExtractOutcome | null = null;
    try {
      outcome =
        source.format === 'txt'
          ? extractTxt(source)
          : source.format === 'docx'
            ? extractDocx(source)
            : source.format === 'doc'
              ? extractDoc(source)
              : source.format === 'pdf'
                ? extractPdfText(source)
                : null;
    } catch (error) {
      // 单个来源的解析异常必须收敛成 failed 记录：整批不能中断，也不能留下无原因的 pending。
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const looksLikeWrongFormat = source.format === 'doc' && /OLE2|复合文档/.test(reason);
      source.processing.status = 'failed';
      source.processing.processedAt = nowIso();
      source.coverage.quality = 'failed';
      source.coverage.processedUnits = '无（提取失败）';
      source.coverage.unprocessedUnits = '全文（提取失败）';
      source.coverage.issues = [
        `解析失败：${reason}`,
        looksLikeWrongFormat
          ? '该文件签名不是 OLE2 复合文档（旧版 DOC），扩展名与真实格式可能不符（如实为 RTF/HTML/纯文本）。' +
            '建议先用文件签名确认格式，再按对应格式重新登记或改用其它工具转换。'
          : '建议检查文件是否损坏、被截断或属于本工具链不支持的变体，然后重试或改用其它工具转换。',
      ];
      upsertManifest(source);
      failures.push(`${source.source_id}（${source.sourceRelativePathFromF}）：${reason}`);
      console.error(`  ${source.source_id}  解析失败，已记为 failed：${reason}`);
      continue;
    }
    if (!outcome) {
      console.log(`  ${source.source_id}（${source.format}）跳过：请用 ocr 子命令处理扫描件`);
      continue;
    }

    // 空正文/异常过短不得当作成功：任务书要求失败要显式记录，不能生成空白“成功文件”。
    const nonWhitespace = outcome.text.replace(/\s/g, '').length;
    if (nonWhitespace < 20) {
      outcome.quality = 'failed';
      outcome.processedUnits = '无（提取失败）';
      outcome.unprocessed = '全文（提取失败）';
      outcome.issues = [
        ...outcome.issues,
        `提取正文过短（非空白字符 ${nonWhitespace} 个）：按 failed 处理，不生成清洗文件。` +
          '可能原因：原件为空、编码不可识别、或该格式变体不被自实现解析器支持；请检查原件后重试或换用其它工具。',
      ];
    }
    const extractedRelative = `corpus/extracted/${source.source_id}.txt`;
    const header = [
      `## source_id: ${source.source_id}`,
      `## 原件: ${source.originalRelativePath}`,
      `## sha256: ${source.sha256}`,
      `## 提取器: ${outcome.extractor} (${outcome.extractorVersion})`,
      `## 覆盖: ${outcome.processedUnits}｜未处理: ${outcome.unprocessed ?? '无'}`,
      `## 说明: 本文件是机器提取的忠实文本；页/段边界按原格式保留，不做文字改写。`,
      '',
    ].join('\n');
    writeText(fromProjectRelative(extractedRelative), `${header}${outcome.text}\n`);

    const stats = textStats(outcome.text, outcome.paragraphs);
    source.processing.status = outcome.quality === 'failed' ? 'failed' : 'processed';
    source.processing.inputEncoding = outcome.encoding;
    source.processing.extractor = outcome.extractor;
    source.processing.extractorVersion = outcome.extractorVersion;
    source.processing.processedAt = nowIso();
    source.processing.extractedPath = extractedRelative;
    source.processing.assetPaths = [...new Set([...source.processing.assetPaths, ...outcome.assets])];
    source.coverage.structureSummary = outcome.structure;
    source.coverage.totalUnits = outcome.totalUnits;
    source.coverage.processedUnits = outcome.processedUnits;
    source.coverage.unprocessedUnits = outcome.unprocessed;
    source.coverage.quality = outcome.quality;
    source.coverage.issues = outcome.issues;
    replaceNote(source, '提取统计：', `提取统计：${stats.chars} 字符 / ${stats.cjkChars} 汉字 / ${stats.paragraphs} 段`);
    upsertManifest(source);
    console.log(
      `  ${source.source_id}  ${source.format.padEnd(8)} ${stats.chars} 字符（汉字 ${stats.cjkChars}）质量=${outcome.quality}` +
        (outcome.issues.length > 0 ? ` 问题 ${outcome.issues.length} 条` : ''),
    );
  }
  if (failures.length > 0) {
    console.error(`\n提取失败 ${failures.length} 个来源（其余来源已继续处理并写入 manifest）：`);
    for (const item of failures) console.error(`  - ${item}`);
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ ocr */

interface OcrMeta {
  engine: string;
  language: string;
  lines: number;
  chars: number;
  scale: number;
  maxDim: number;
  image: string;
  imageBytes: number;
}

function commandOcr(options: Map<string, string[]>): void {
  const pages = options.get('pages')?.[0] ?? '1-3';
  for (const source of selectedSources(options)) {
    if (source.format !== 'pdf-scan' && source.format !== 'pdf') {
      console.log(`  ${source.source_id} 跳过：只有 PDF 需要渲染 + OCR`);
      continue;
    }
    const original = fromProjectRelative(source.originalRelativePath);
    const work = path.join(workDir, source.source_id);
    ensureDir(work);
    const renderDir = path.join(work, 'pages');
    const renderMetaPath = path.join(work, 'render-meta.json');
    console.log(`  渲染 ${source.source_id} 第 ${pages} 页 …`);
    runPowerShell(RENDER_SCRIPT, [
      '-PdfPath', original,
      '-OutDir', renderDir,
      '-Pages', pages,
      '-Scale', '1',
      '-OutMeta', renderMetaPath,
    ]);
    const renderMeta = readJsonFile<{ pageCount: number; rendered: Array<{ page: number; file: string; pixels: string; bytes: number }> }>(renderMetaPath);

    const pageTexts: Array<{ page: number; text: string }> = [];
    const assetPaths: string[] = [];
    const toolVersions: Array<{ name: string; version: string; command: string }> = [];
    let ocrEngine = '';
    let ocrLanguage = '';
    const issues: string[] = [];

    for (const rendered of renderMeta.rendered) {
      const imagePath = path.join(renderDir, rendered.file);
      const textPath = path.join(work, `ocr-${rendered.page}.txt`);
      const metaPath = path.join(work, `ocr-${rendered.page}.json`);
      runPowerShell(OCR_SCRIPT, [
        '-ImagePath', imagePath,
        '-Language', 'zh-Hans-CN',
        '-Scale', '2',
        '-OutText', textPath,
        '-OutMeta', metaPath,
      ]);
      const meta = readJsonFile<OcrMeta>(metaPath);
      ocrEngine = meta.engine;
      ocrLanguage = meta.language;
      const raw = fs.readFileSync(textPath, 'utf8');
      const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
      pageTexts.push({ page: rendered.page, text: lines.join('\n') });
      if (meta.chars === 0) issues.push(`第 ${rendered.page} 页 OCR 未识别到文字`);

      // 原页证据：完整渲染图留在 storage/work，打包资产用受限宽度的 JPEG。
      const assetTarget = path.join(assetsDir, source.source_id, `page-${String(rendered.page).padStart(3, '0')}.jpg`);
      runPowerShell(DOWNSCALE_SCRIPT, [
        '-InputPath', imagePath,
        '-OutputPath', assetTarget,
        '-MaxWidth', '1400',
        '-Quality', '82',
      ]);
      assetPaths.push(relativeToProject(assetTarget));
      console.log(`    第 ${rendered.page} 页：OCR ${meta.chars} 字符（${rendered.pixels}，scale ${meta.scale}）`);
    }

    const text = pageTexts.map((page) => `===== 扫描页（PDF 第 ${page.page} 页）=====\n${page.text}`).join('\n');
    const extractedRelative = `corpus/extracted/${source.source_id}.txt`;
    const header = [
      `## source_id: ${source.source_id}`,
      `## 原件: ${source.originalRelativePath}`,
      `## sha256: ${source.sha256}`,
      `## 提取方式: Windows 内建 PDF 渲染 + Windows.Media.Ocr（离线，无云端调用）`,
      `## 覆盖: PDF 第 ${renderMeta.rendered.map((item) => item.page).join(', ')} 页（共 ${renderMeta.pageCount} 页）`,
      '',
    ].join('\n');
    writeText(fromProjectRelative(extractedRelative), `${header}${text}\n`);

    toolVersions.push({
      name: 'Windows.Data.Pdf (pdf-render.ps1)',
      version: `${process.env.OS ?? 'Windows'} / ${renderMeta.pageCount} 页`,
      command: `powershell -File tools/offline/pdf-render.ps1 -PdfPath <原件> -OutDir <临时目录> -Pages ${pages} -Scale 1`,
    });
    toolVersions.push({
      name: ocrEngine || 'Windows.Media.Ocr (ocr-image.ps1)',
      version: `${ocrLanguage} / MaxImageDimension ${renderMeta.rendered.length > 0 ? '' : ''}`.trim(),
      command: `powershell -File tools/offline/ocr-image.ps1 -ImagePath <页图> -Language zh-Hans-CN -Scale 2 -OutText <文本> -OutMeta <元数据>`,
    });

    source.processing.status = 'processed';
    source.processing.inputEncoding = '图像（OCR 文本）';
    source.processing.extractor = 'tools/offline/pdf-render.ps1 + tools/offline/ocr-image.ps1';
    source.processing.extractorVersion = ocrEngine;
    source.processing.ocrLanguage = ocrLanguage;
    source.processing.processedAt = nowIso();
    source.processing.extractedPath = extractedRelative;
    source.processing.assetPaths = assetPaths;
    source.processing.tools = toolVersions;
    source.coverage.structureSummary = `扫描 PDF（无文字层）：共 ${renderMeta.pageCount} 页，渲染 ${renderMeta.rendered.length} 页后逐页 OCR`;
    source.coverage.totalUnits = `${renderMeta.pageCount} 页`;
    source.coverage.processedUnits = `第 ${renderMeta.rendered.map((item) => item.page).join(', ')} 页`;
    source.coverage.unprocessedUnits =
      renderMeta.rendered.length < renderMeta.pageCount
        ? `未处理第 ${Array.from({ length: renderMeta.pageCount }, (_, index) => index + 1)
            .filter((page) => !renderMeta.rendered.some((item) => item.page === page))
            .join(', ')} 页`
        : null;
    source.coverage.quality = issues.length === 0 ? 'needs_review' : 'needs_review';
    source.coverage.issues = [
      ...issues,
      'OCR 结果未经逐字人工校对；识别质量抽查见质量报告，疑问处不得作为默认规则。',
    ];
    source.notes.push(`OCR：${renderMeta.rendered.length} 页，引擎 ${ocrEngine}`);
    upsertManifest(source);
    console.log(`  ${source.source_id} OCR 完成：${renderMeta.rendered.length} 页 → ${extractedRelative}`);
  }
}

/* ------------------------------------------------------------------ assets */

/** 为 PDF 的指定页生成页面图资产（卦图/爻位/表格等需要看原页的位置）。 */
function commandAssets(options: Map<string, string[]>): void {
  const requested = options.get('pages')?.[0] ?? '1-2';
  const pages = requested === 'all' ? '1-9999' : requested;
  for (const source of selectedSources(options)) {
    if (!source.format.startsWith('pdf')) {
      console.log(`  ${source.source_id} 跳过：只有 PDF 需要渲染页面图`);
      continue;
    }
    const { assets } = buildPageAssets(source, pages);
    source.processing.assetPaths = [...new Set([...source.processing.assetPaths, ...assets])];
    source.notes.push(`页面图资产：第 ${pages} 页，${assets.length} 个 JPEG（宽 ≤1400，质量 82）`);
    upsertManifest(source);
    console.log(`  ${source.source_id} 生成 ${assets.length} 个页面图资产（第 ${pages} 页）`);
    for (const asset of assets) console.log(`    ${asset}`);
  }
}

/* ------------------------------------------------------------------ clean */

interface CleanResult {
  markdown: string;
  notes: string[];
  removedLines: number;
}

const WEB_JUNK_PATTERNS: RegExp[] = [
  /^\s*(?:www\.|https?:\/\/|微信|QQ群|公众号|版权|免责声明|转载|更多资料|欢迎访问)/i,
  /^\s*[-=_*]{6,}\s*$/,
];

/** 页标记：既支持提取器写出的 `===== PDF 第 N 页 =====`，也支持 OCR 的扫描页标记。 */
const PAGE_MARKER = /^=+\s*(?:扫描页（)?PDF 第\s*(\d+)\s*页[^=]*=+$/;

/**
 * 生成清洗 Markdown。
 *
 * 结构处理方式按格式区分（这是定位可靠性的前提）：
 *   - txt / doc / docx：散文式，空行分段；
 *   - pdf（文字层）/ pdf-scan（OCR）：行式文本，每行即一段，页标记单独成标题。
 * OCR 文本会折叠汉字之间的空格；不做错别字订正。
 */
function cleanText(source: ManifestSource, outcome: ExtractOutcome, pageAssets: Map<number, string>): CleanResult {
  const notes: string[] = [];
  let removedLines = 0;
  const isOcr = source.format === 'pdf-scan';
  const lineOriented = source.format === 'pdf' || source.format === 'pdf-scan';

  const paragraphs: Array<{ kind: 'page' | 'text'; value: string }> = [];

  if (lineOriented) {
    // PDF/OCR：行式文本，每行一段，页标记单独成标题。
    for (const rawLine of normalizeNewlines(outcome.text).split('\n')) {
      const line = rawLine.trim();
      const pageMatch = PAGE_MARKER.exec(line);
      if (pageMatch) {
        paragraphs.push({ kind: 'page', value: pageMatch[1]! });
        continue;
      }
      if (line === '') continue;
      if (WEB_JUNK_PATTERNS.some((pattern) => pattern.test(line))) {
        removedLines += 1;
        continue;
      }
      const text = normalizeFullWidthSpaces(isOcr ? collapseCjkSpaces(line) : line).trim();
      if (text.length > 1) paragraphs.push({ kind: 'text', value: text });
    }
  } else {
    // 散文来源（txt/doc/docx）：沿用提取阶段的段落分块，保证已有定位锚点稳定。
    for (const block of outcome.paragraphs) {
      const lines = block.split('\n').map((line) => line.trim());
      const pageMatch = lines.length > 0 ? PAGE_MARKER.exec(lines[0]!) : null;
      if (pageMatch) {
        paragraphs.push({ kind: 'page', value: pageMatch[1]! });
        lines.shift();
      }
      const kept: string[] = [];
      for (const line of lines) {
        if (line === '') continue;
        if (WEB_JUNK_PATTERNS.some((pattern) => pattern.test(line))) {
          removedLines += 1;
          continue;
        }
        kept.push(line);
      }
      const text = normalizeFullWidthSpaces(kept.join('')).trim();
      if (text.length > 1) paragraphs.push({ kind: 'text', value: text });
    }
  }

  if (removedLines > 0) notes.push(`删除疑似网页转载/广告/分隔线 ${removedLines} 行（规则见 tools/corpus-cli.ts WEB_JUNK_PATTERNS）`);
  if (isOcr) notes.push('OCR 文本：已折叠汉字之间的空格；未做错别字订正，未辨认处保持原样');
  if (lineOriented) notes.push('PDF/OCR 文本按行成段，页标记单独成标题，便于按页定位');

  const body: string[] = [];
  let counter = 0;
  const blockCharPages: number[] = [];
  const missingFigurePages: number[] = [];

  // 按页分组：页标记单独成标题，并在页内嵌原页图，使图表/爻位可在 Markdown 中直接核对。
  const groups: Array<{ page: number | null; items: string[] }> = [];
  for (const paragraph of paragraphs) {
    if (paragraph.kind === 'page') {
      groups.push({ page: Number.parseInt(paragraph.value, 10), items: [] });
      continue;
    }
    if (groups.length === 0) groups.push({ page: null, items: [] });
    groups[groups.length - 1]!.items.push(paragraph.value);
  }

  for (const group of groups) {
    if (group.page !== null) {
      body.push(`\n## 第 ${group.page} 页（PDF 实际页码）\n`);
      const asset = pageAssets.get(group.page);
      const hasBlockChars = group.items.some((item) => item.includes('█'));
      if (hasBlockChars) blockCharPages.push(group.page);
      if (asset) {
        body.push(`![第 ${group.page} 页原页图](${asset})`);
        body.push('');
      } else if (hasBlockChars) {
        missingFigurePages.push(group.page);
      }
      // 若该页已有结构化转写（人工目视原页图），在页内给出链接。
      const figureFile = `corpus/figures/${source.source_id}/page-${String(group.page).padStart(3, '0')}.md`;
      if (fs.existsSync(fromProjectRelative(figureFile))) {
        body.push(
          `> 卦盘结构化转写（人工目视原页图核对）：[第 ${group.page} 页转写](${path.posix.relative('corpus/cleaned', figureFile)})`,
        );
        body.push('');
      }
      if (hasBlockChars) {
        body.push(
          `> ⚠ 本页含方块占位字符（██ 等）：原书卦图/爻位无法由文字层还原，**本页卦例不作为默认规则**；` +
            (asset ? '请对照上方原页图人工辨认。' : '本页缺少原页图，需按第 8 节命令重跑生成后再核对。'),
        );
        body.push('');
      }
    }
    for (const item of group.items) {
      counter += 1;
      const anchor = stableId(source.source_id, 'paragraph', counter, item.slice(0, 24));
      body.push(`<!-- ¶${String(counter).padStart(4, '0')} ${anchor} -->`);
      body.push(item);
      body.push('');
    }
  }
  notes.push(`清洗段落锚点：${counter} 个（¶0001..¶${String(counter).padStart(4, '0')}）`);
  if (blockCharPages.length > 0) {
    notes.push(
      `含方块占位字符（卦图/爻位无法还原）的页：${blockCharPages.join(', ')}（共 ${blockCharPages.length} 页），` +
        `已在各页标注并附原页图；这些页的卦例不作默认规则`,
    );
  }
  if (missingFigurePages.length > 0) {
    notes.push(`缺少原页图的卦图页：${missingFigurePages.join(', ')}（需生成资产后再核对）`);
  }

  const title = titleFromPath(source.sourceRelativePathFromF);
  const front = [
    `# ${title}`,
    '',
    `> - 来源：[\`${source.source_id}\`](../../wiki/sources/${source.source_id}.md)`,
    `> - 包内原件：\`${source.originalRelativePath}\``,
    `> - 忠实提取文本：\`${source.processing.extractedPath}\``,
    `> - 覆盖范围：${source.coverage.processedUnits}${source.coverage.unprocessedUnits ? `（未处理：${source.coverage.unprocessedUnits}）` : ''}`,
    `> - 质量状态：\`${source.coverage.quality}\``,
    `> - 提取器：${source.processing.extractor}（${source.processing.extractorVersion}）`,
    `> - 本文件由机器清洗生成：只做编码、换行、段落与标题层级处理；**未经人工校对的文字不代表已确认**。`,
    `> - 段落锚点格式：\`<!-- ¶NNNN -->\`，供 Wiki 定位引用。`,
    '',
  ].join('\n');
  return { markdown: `${front}${body.join('\n')}\n`, notes, removedLines };
}

function commandClean(options: Map<string, string[]>): void {
  for (const source of selectedSources(options)) {
    if (source.processing.status === 'failed' || source.coverage.quality === 'failed') {
      console.log(
        `  ${source.source_id} 跳过：来源状态为 failed（${source.coverage.issues[0] ?? '提取失败'}），不生成空白清洗文件`,
      );
      continue;
    }
    if (!source.processing.extractedPath) {
      console.log(`  ${source.source_id} 跳过：还没有提取文本`);
      continue;
    }
    const outcome = rebuildOutcomeFromExtracted(source);
    // 页图资产 → 相对 corpus/cleaned/ 的链接，使 Markdown 内可直接核对卦图/爻位。
    const pageAssets = new Map<number, string>();
    for (const asset of source.processing.assetPaths) {
      const match = /page-(\d{3})\.(?:jpg|png)$/.exec(asset);
      if (match) pageAssets.set(Number.parseInt(match[1]!, 10), path.posix.relative('corpus/cleaned', asset));
    }
    const cleaned = cleanText(source, outcome, pageAssets);
    const cleanedRelative = `corpus/cleaned/${source.source_id}.md`;
    writeText(fromProjectRelative(cleanedRelative), cleaned.markdown);
    source.processing.cleanedPath = cleanedRelative;
    const anchorCount = (cleaned.markdown.match(/^<!-- ¶\d{4} /gm) ?? []).length;
    replaceNote(
      source,
      '清洗：',
      `清洗：段落锚点 ${anchorCount} 个（提取器分块 ${outcome.paragraphs.length} 个），删除行 ${cleaned.removedLines}`,
    );
    // 清洗说明整组重建，避免复跑时重复追加。
    source.notes = source.notes.filter(
      (note) => !note.startsWith('清洗说明：') && !note.startsWith('段落锚点：') && !note.startsWith('含方块占位字符') && !note.startsWith('缺少原页图'),
    );
    for (const note of cleaned.notes) source.notes.push(`清洗说明：${note}`);
    // 含卦图/爻位占位字符的来源：按任务书第 6 节缩小 usable 范围，改为 needs_review。
    const blockNote = cleaned.notes.find((note) => note.startsWith('含方块占位字符'));
    if (blockNote && source.coverage.quality !== 'failed') {
      source.coverage.quality = 'needs_review';
      const issueText = `${blockNote}。该来源的文字论述可读，但含卦图/爻位的页不作为默认规则，引用前须对照原页图`;
      source.coverage.issues = [issueText, ...source.coverage.issues.filter((issue) => !issue.startsWith('含方块占位字符'))];
    }
    upsertManifest(source);
    const stats = textStats(cleaned.markdown, outcome.paragraphs);
    console.log(
      `  ${source.source_id}  ${cleanedRelative}  ${stats.chars} 字符 / 清洗段落 ${anchorCount} 个（提取器分块 ${outcome.paragraphs.length}）`,
    );
  }
}

/** Re-read the extracted text so clean/verify always work from the on-disk artefacts. */
function rebuildOutcomeFromExtracted(source: ManifestSource): ExtractOutcome {
  const raw = fs.readFileSync(fromProjectRelative(source.processing.extractedPath!), 'utf8');
  const lines = raw.split('\n');
  const bodyStart = lines.findIndex((line, index) => index > 0 && !line.startsWith('##') && line.trim() !== '');
  const body = lines.slice(bodyStart < 0 ? 0 : bodyStart).join('\n');
  return {
    text: body,
    encoding: source.processing.inputEncoding,
    extractor: source.processing.extractor ?? '',
    extractorVersion: source.processing.extractorVersion ?? '',
    structure: source.coverage.structureSummary,
    totalUnits: source.coverage.totalUnits,
    processedUnits: source.coverage.processedUnits,
    unprocessed: source.coverage.unprocessedUnits,
    issues: source.coverage.issues,
    quality: source.coverage.quality,
    assets: source.processing.assetPaths,
    paragraphs: splitParagraphs(body),
  };
}

/* ------------------------------------------------------------------ report */

interface SpotCheckNotes {
  reviewer: string;
  method: string;
  checkedAt: string;
  whySelected: string;
  spotChecks: Array<{ where: string; locator: string; finding: string }>;
  cleaningDecisions: string[];
  knownIssues: string[];
  recommendation: string;
}

function commandReport(options: Map<string, string[]>): void {
  for (const source of selectedSources(options)) {
    const notesPath = path.join(reportsDir, 'spotcheck', `${source.source_id}.json`);
    const notes = fs.existsSync(notesPath) ? readJsonFile<SpotCheckNotes>(notesPath) : null;
    const extracted = source.processing.extractedPath
      ? fs.readFileSync(fromProjectRelative(source.processing.extractedPath), 'utf8')
      : '';
    const cleaned = source.processing.cleanedPath ? fs.readFileSync(fromProjectRelative(source.processing.cleanedPath), 'utf8') : '';
    const paragraphs = extracted ? splitParagraphs(extracted) : [];
    const stats = textStats(extracted, paragraphs);
    const cleanedStats = cleaned ? textStats(cleaned, splitParagraphs(cleaned)) : null;

    const lines: string[] = [];
    lines.push(`# 质量报告：${source.source_id}`);
    lines.push('');
    lines.push(`- 原件（包内）：\`${source.originalRelativePath}\``);
    lines.push(`- F 盘相对路径：\`${source.sourceRelativePathFromF}\`（仅审计记录）`);
    lines.push(`- SHA-256：\`${source.sha256}\``);
    lines.push(`- 字节数：${source.sizeBytes.toLocaleString('en-US')}；格式：${source.format}（${source.extension}）`);
    lines.push(`- 质量状态：**\`${source.coverage.quality}\`**`);
    lines.push(`- 覆盖：${source.coverage.processedUnits}${source.coverage.unprocessedUnits ? `；未处理：${source.coverage.unprocessedUnits}` : '（全文）'}`);
    lines.push('');
    lines.push('## 1. 样本为何入选');
    lines.push('');
    lines.push(notes?.whySelected ?? `（未填写）角色见 tools/sample-set.json；选择依据以正文抽查为准，不以文件名判断内容。`);
    lines.push('');
    lines.push('## 2. 结构与处理范围');
    lines.push('');
    lines.push(`- 结构概况：${source.coverage.structureSummary || '（未记录）'}`);
    lines.push(`- 单位总量：${source.coverage.totalUnits || '（未记录）'}`);
    lines.push(`- 已处理：${source.coverage.processedUnits || '（未记录）'}`);
    lines.push(`- 未处理：${source.coverage.unprocessedUnits ?? '无'}`);
    lines.push('');
    lines.push('## 3. 工具与版本');
    lines.push('');
    lines.push(`- 提取器：${source.processing.extractor ?? '（未记录）'}（${source.processing.extractorVersion ?? '-'}）`);
    if (source.processing.ocrLanguage) lines.push(`- OCR 语言：${source.processing.ocrLanguage}`);
    for (const tool of source.processing.tools) lines.push(`- ${tool.name}：${tool.version}\n  - 重跑：\`${tool.command}\``);
    lines.push('');
    lines.push('## 4. 编码 / OCR 情况');
    lines.push('');
    lines.push(`- 输入编码或图像来源：${source.processing.inputEncoding ?? '（未记录）'}`);
    const anchorCount = cleaned ? (cleaned.match(/^<!-- ¶\d{4} /gm) ?? []).length : 0;
    if (stats.replacementChars > 0) lines.push(`- 提取文本中的替换字符：${stats.replacementChars} 个`);
    lines.push(`- 提取文本：${stats.chars.toLocaleString('en-US')} 字符（汉字 ${stats.cjkChars.toLocaleString('en-US')}）`);
    lines.push(`- 提取器分块数：${stats.paragraphs}（提取阶段按空行/换行的启发式切分，只表示切分粒度）`);
    if (cleanedStats) lines.push(`- 清洗后 Markdown：${cleanedStats.chars.toLocaleString('en-US')} 字符`);
    lines.push(`- 清洗段落锚点数：**${anchorCount}**（Wiki 定位使用的 \`<!-- ¶NNNN -->\` 数目，判断漏页漏段以此为准）`);
    if (cleanedStats && anchorCount !== stats.paragraphs) {
      lines.push(
        `- 说明：提取器分块数（${stats.paragraphs}）与清洗段落锚点数（${anchorCount}）不同属正常：前者是提取阶段的启发式切分，后者按页/行结构重排；两者都不是“页数”。`,
      );
    }
    lines.push('');
    lines.push('## 5. 人工目视抽查记录');
    lines.push('');
    if (notes) {
      lines.push(`- 抽查人/方式：${notes.reviewer}｜${notes.method}｜${notes.checkedAt}`);
      lines.push('');
      lines.push('| 位置 | 定位 | 发现 |');
      lines.push('| --- | --- | --- |');
      for (const check of notes.spotChecks) lines.push(`| ${check.where} | ${check.locator} | ${check.finding} |`);
    } else {
      lines.push('（未填写抽查记录：本报告不得视为已完成内容核对）');
    }
    lines.push('');
    lines.push('## 6. 疑点、缺失与图表损失');
    lines.push('');
    const issues = [...source.coverage.issues, ...(notes?.knownIssues ?? [])];
    if (issues.length === 0) lines.push('- 暂无记录');
    else for (const issue of issues) lines.push(`- ${issue}`);
    lines.push('');
    lines.push('## 7. 清洗改动');
    lines.push('');
    const cleaningNotes = source.notes.filter((note) => note.startsWith('清洗'));
    if (cleaningNotes.length === 0 && (notes?.cleaningDecisions.length ?? 0) === 0) lines.push('- 无');
    else {
      for (const note of cleaningNotes) lines.push(`- ${note}`);
      for (const decision of notes?.cleaningDecisions ?? []) lines.push(`- ${decision}`);
    }
    lines.push('');
    lines.push('## 8. 图片与可定位资产');
    lines.push('');
    if (source.processing.assetPaths.length === 0) lines.push('- 无（本来源未导出图片）');
    else for (const asset of source.processing.assetPaths) lines.push(`- \`${asset}\``);
    lines.push('');
    lines.push('## 9. 结论与后续处理建议');
    lines.push('');
    lines.push(notes?.recommendation ?? '（未填写）');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`生成时间：${nowIso()}｜生成命令：\`node tools/corpus-cli.ts report --all\``);
    lines.push('');
    lines.push('> 质量状态定义见 docs/phase2_development_spec.md 第 6 节；`usable` 仅表示在声明范围内定位可靠，不代表预测正确。');

    const reportRelative = `corpus/reports/${source.source_id}.md`;
    writeText(fromProjectRelative(reportRelative), `${lines.join('\n')}\n`);
    console.log(`  ${source.source_id}  → ${reportRelative}`);
  }
}

/* ------------------------------------------------------------------ verify */

interface VerifyFinding {
  level: 'ok' | 'warn' | 'fail';
  scope: string;
  message: string;
}

function commandVerify(): void {
  const findings: VerifyFinding[] = [];
  const manifest = readManifest();
  const ids = new Set(manifest.map((item) => item.source_id));

  // 1) 原件存在且哈希一致；提取/清洗文件存在。
  for (const source of manifest) {
    const original = fromProjectRelative(source.originalRelativePath);
    if (!fs.existsSync(original)) {
      findings.push({ level: 'fail', scope: source.source_id, message: `包内原件缺失：${source.originalRelativePath}` });
      continue;
    }
    const actual = sha256File(original);
    findings.push({
      level: actual === source.sha256 ? 'ok' : 'fail',
      scope: source.source_id,
      message: actual === source.sha256 ? '包内原件 SHA-256 一致' : `包内原件哈希不一致：${actual}`,
    });
    if (source.processing.extractedPath) {
      const exists = fs.existsSync(fromProjectRelative(source.processing.extractedPath));
      findings.push({ level: exists ? 'ok' : 'fail', scope: source.source_id, message: `提取文本${exists ? '存在' : '缺失'}：${source.processing.extractedPath}` });
    }
    if (source.processing.cleanedPath) {
      const exists = fs.existsSync(fromProjectRelative(source.processing.cleanedPath));
      findings.push({ level: exists ? 'ok' : 'fail', scope: source.source_id, message: `清洗文本${exists ? '存在' : '缺失'}：${source.processing.cleanedPath}` });
    }
    for (const asset of source.processing.assetPaths) {
      const exists = fs.existsSync(fromProjectRelative(asset));
      findings.push({ level: exists ? 'ok' : 'fail', scope: source.source_id, message: `图片资产${exists ? '存在' : '缺失'}：${asset}` });
    }
  }

  // 2) 同哈希别名与近名不同哈希的关系记录。
  const byHash = new Map<string, ManifestSource[]>();
  for (const source of manifest) {
    const list = byHash.get(source.sha256) ?? [];
    list.push(source);
    byHash.set(source.sha256, list);
  }
  for (const [hash, list] of byHash) {
    if (list.length > 1) {
      findings.push({
        level: list.filter((item) => item.duplicateOf === null).length === 1 ? 'ok' : 'warn',
        scope: hash.slice(0, 12),
        message: `相同哈希的来源 ${list.length} 个：${list.map((item) => `${item.source_id}(${item.sourceRelativePathFromF})`).join(' / ')}`,
      });
    }
  }

  // 3) Wiki 相对链接与定位。
  const wikiFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) wikiFiles.push(full);
    }
  };
  walk(path.join(projectRoot, 'wiki'));
  // 清洗文本也含相对链接（来源页、原页图），必须一起校验。
  walk(cleanedDir);
  // 卦盘等结构化转写文件同样参与链接与出处校验。
  walk(path.join(projectRoot, 'corpus', 'figures'));
  // 链接目标允许 <...> 形式（文件名含括号时必须使用），因此正则先匹配尖括号整体。
  const markdownLink = /\[[^\]]*\]\(\s*(<[^>]*>|[^)]+)\s*\)/g;
  for (const file of wikiFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const relativeFile = relativeToProject(file);
    // 链接扫描先去掉代码块/行内代码，避免把文档里的示例当成失效链接；
    // 定位与 source_id 扫描仍用原文（它们本身写在反引号里）。
    const linkContent = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const match of linkContent.matchAll(markdownLink)) {
      let target = match[1]!.trim();
      // Markdown allows <...> destinations (needed for file names containing parentheses).
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      try {
        target = decodeURI(target);
      } catch {
        /* keep raw target */
      }
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target.split('#')[0]!);
      if (!fs.existsSync(resolved)) {
        findings.push({ level: 'fail', scope: relativeFile, message: `相对链接失效：${target}` });
      } else if (path.isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
        findings.push({ level: 'fail', scope: relativeFile, message: `链接使用了绝对路径：${target}` });
      }
    }
    // source_id 引用必须存在
    for (const match of content.matchAll(/`(src-[0-9a-f]{12,})`/g)) {
      const id = match[1]!;
      if (!ids.has(id)) findings.push({ level: 'fail', scope: relativeFile, message: `引用了不存在的 source_id：${id}` });
    }
    // 定位校验：
    //   - 来源页（wiki/sources/<id>.md）：允许只写 `¶NNNN`，来源由页面自身推断；
    //   - 其他页面：必须在同一行内先写 `src-...`，否则会与其它来源的锚点混淆。
    const isSourcePage = path.basename(path.dirname(file)) === 'sources';
    const inferredId = isSourcePage ? path.basename(file, '.md') : null;
    const locatorPattern = /`(src-[0-9a-f]{12,})`[^\n]*?`¶(\d{4})`([^\n]*)|`¶(\d{4})`([^\n]*)/g;
    for (const match of content.matchAll(locatorPattern)) {
      const sourceId = match[1] ?? inferredId;
      const locator = `¶${match[2] ?? match[4]}`;
      const rest = match[3] ?? match[5] ?? '';
      if (!sourceId) {
        findings.push({ level: 'fail', scope: relativeFile, message: `定位 ${locator} 未指明 source_id（非来源页必须写出来源 ID）` });
        continue;
      }
      const source = manifest.find((item) => item.source_id === sourceId);
      if (!source?.processing.cleanedPath) {
        findings.push({ level: 'fail', scope: relativeFile, message: `定位 ${locator} 指向的来源没有清洗文本：${sourceId}` });
        continue;
      }
      const cleanedText = fs.readFileSync(fromProjectRelative(source.processing.cleanedPath), 'utf8');
      if (!cleanedText.includes(`<!-- ${locator} `)) {
        findings.push({ level: 'fail', scope: relativeFile, message: `定位 ${locator} 在 ${sourceId} 的清洗文本中不存在` });
        continue;
      }
      const quote = /「([^」]{4,})」/.exec(rest)?.[1];
      if (quote) {
        const plain = cleanedText.replace(/\s+/g, '');
        const needle = quote.replace(/\s+/g, '');
        if (!plain.includes(needle)) {
          findings.push({
            level: 'fail',
            scope: relativeFile,
            message: `${locator} 的起始语与 ${sourceId} 清洗文本不符：「${quote}」`,
          });
        }
      }
    }
    // F 盘绝对路径只允许作为审计历史出现（同一行需标注「审计」或为“初次导入来源”行）。
    for (const line of content.split('\n')) {
      if (!/[A-Z]:\\/.test(line)) continue;
      if (line.includes('审计') || line.includes('初次导入来源')) continue;
      findings.push({
        level: 'warn',
        scope: relativeFile,
        message: `出现未标注为审计记录的盘符绝对路径：${line.trim().slice(0, 80)}`,
      });
    }
  }

  // 4) F 盘原件未被修改（哈希 + 修改时间）。
  const set = readSampleSet();
  for (const source of manifest) {
    const drivePath = path.join(set.sourceRoot, source.sourceRelativePathFromF);
    if (!fs.existsSync(drivePath)) {
      findings.push({ level: 'warn', scope: source.source_id, message: 'F 盘原件当前不可访问，未能复核' });
      continue;
    }
    const driveSha = sha256File(drivePath);
    const stat = fs.statSync(drivePath);
    findings.push({
      level: driveSha === source.sha256 && stat.size === source.sizeBytes ? 'ok' : 'fail',
      scope: source.source_id,
      message:
        driveSha === source.sha256 && stat.size === source.sizeBytes
          ? `F 盘原件与导入时一致（${stat.size} 字节，mtime ${stat.mtime.toISOString()}）`
          : `F 盘原件与导入记录不一致（sha ${driveSha.slice(0, 12)}… / ${stat.size} 字节）`,
    });
  }

  // 5) manifest 结构完整性。
  for (const source of manifest) {
    const missing: string[] = [];
    if (!source.sha256 || source.sha256.length !== 64) missing.push('sha256');
    if (!source.originalRelativePath) missing.push('originalRelativePath');
    if (!source.coverage.quality) missing.push('coverage.quality');
    if (!source.processing.status) missing.push('processing.status');
    if (missing.length > 0) findings.push({ level: 'fail', scope: source.source_id, message: `manifest 缺字段：${missing.join(', ')}` });
  }

  // 6) 质量状态与产物一致性；含卦图/爻位占位字符的页必须有原页图。
  for (const source of manifest) {
    const extractedAbsolute = source.processing.extractedPath ? fromProjectRelative(source.processing.extractedPath) : null;
    const body =
      extractedAbsolute && fs.existsSync(extractedAbsolute)
        ? fs
            .readFileSync(extractedAbsolute, 'utf8')
            .split('\n')
            .filter((line) => !line.startsWith('##'))
            .join('')
        : '';
    const nonWhitespace = body.replace(/\s/g, '').length;
    const cleanedExists = Boolean(
      source.processing.cleanedPath && fs.existsSync(fromProjectRelative(source.processing.cleanedPath)),
    );
    if (source.processing.status === 'failed' || source.coverage.quality === 'failed') {
      findings.push({
        level: cleanedExists ? 'fail' : 'ok',
        scope: source.source_id,
        message: cleanedExists
          ? '状态为 failed 却存在清洗文件（不得生成空白“成功文件”）'
          : `failed 状态已如实记录且无清洗文件：${source.coverage.issues[0] ?? '（未写原因）'}`,
      });
      continue;
    }
    findings.push({
      level: nonWhitespace >= 20 ? 'ok' : 'fail',
      scope: source.source_id,
      message:
        nonWhitespace >= 20
          ? `提取正文非空（非空白字符 ${nonWhitespace}），状态 ${source.processing.status}/${source.coverage.quality}`
          : `提取正文过短（非空白字符 ${nonWhitespace}）却标记为 ${source.coverage.quality}`,
    });
    if (source.coverage.quality === 'usable' && nonWhitespace < 200) {
      findings.push({ level: 'warn', scope: source.source_id, message: `质量 usable 但正文仅 ${nonWhitespace} 个非空白字符，请复核` });
    }
  }

  for (const source of manifest) {
    if (!source.processing.cleanedPath) continue;
    const cleanedText = fs.readFileSync(fromProjectRelative(source.processing.cleanedPath), 'utf8');
    const sections = cleanedText.split(/^## 第 (\d+) 页/m);
    for (let index = 1; index < sections.length; index += 2) {
      const page = Number.parseInt(sections[index]!, 10);
      const sectionBody = sections[index + 1] ?? '';
      if (!sectionBody.includes('█')) continue;
      const hasImage = /!\[[^\]]*\]\(\.\.\/assets\//.test(sectionBody);
      findings.push({
        level: hasImage ? 'ok' : 'fail',
        scope: `${source.source_id} 第 ${page} 页`,
        message: hasImage ? '含卦图/爻位占位字符，已嵌原页图并在页内标注' : '含卦图/爻位占位字符但未嵌原页图',
      });
    }
  }

  // 7) 卦盘结构化转写：必须写明 source_id 且原页图链接有效（README 是索引，不适用此规则）。
  for (const file of wikiFiles.filter(
    (item) => relativeToProject(item).startsWith('corpus/figures/') && path.basename(item) !== 'README.md',
  )) {
    const relativeFile = relativeToProject(file);
    const content = fs.readFileSync(file, 'utf8');
    const hasSource = /`src-[0-9a-f]{12,}`/.test(content);
    const imageMatch = /!?\[[^\]]*\]\(([^)]*page-\d{3}\.jpg)\)/.exec(content);
    const imageExists = imageMatch ? fs.existsSync(path.resolve(path.dirname(file), imageMatch[1]!)) : false;
    findings.push({
      level: hasSource && imageExists ? 'ok' : 'fail',
      scope: relativeFile,
      message:
        hasSource && imageExists
          ? '卦盘转写含 source_id 且原页图链接有效'
          : '卦盘转写缺少 source_id 或原页图链接失效',
    });
  }

  // 8) 原始字节独立命中：不经提取器，直接在原始载体里找抽样段落。
  for (const source of manifest) {
    if (!['txt', 'doc', 'docx'].includes(source.format) || !source.processing.cleanedPath) continue;
    const cleanedText = fs.readFileSync(fromProjectRelative(source.processing.cleanedPath), 'utf8');
    const paragraphs = cleanedText
      .split('\n')
      .filter((line) => line !== '' && !/^(<!--|>|#|!\[)/.test(line));
    const sample = paragraphs.find((line) => line.replace(/\s/g, '').length >= 14);
    if (!sample) {
      findings.push({ level: 'warn', scope: source.source_id, message: '找不到可用于原始字节核对的抽样段落' });
      continue;
    }
    const needle = sample.replace(/\s/g, '').slice(0, 10);
    const raw = fs.readFileSync(fromProjectRelative(source.originalRelativePath));
    let carrier = '';
    if (source.format === 'txt') carrier = new TextDecoder('gb18030', { fatal: false }).decode(raw);
    else if (source.format === 'doc') carrier = new TextDecoder('utf-16le', { fatal: false }).decode(raw);
    else {
      const documentEntry = readZip(raw).find((entry) => entry.name === 'word/document.xml');
      carrier = documentEntry ? documentEntry.content.toString('utf8') : '';
    }
    const hit = carrier.replace(/\s/g, '').includes(needle);
    findings.push({
      level: hit ? 'ok' : 'fail',
      scope: source.source_id,
      message: hit
        ? `原始载体独立命中抽样段落（“${needle}”，来源=${source.format === 'docx' ? 'word/document.xml' : source.format === 'doc' ? 'UTF-16LE 原始字节' : 'GB18030 原始字节'}）`
        : `原始载体中未找到抽样段落“${needle}”，自实现解析结果需复核`,
    });
  }

  const ok = findings.filter((item) => item.level === 'ok').length;
  const warn = findings.filter((item) => item.level === 'warn').length;
  const fail = findings.filter((item) => item.level === 'fail').length;
  const verbose = process.argv.includes('--verbose');
  console.log('校验结果：');
  for (const finding of findings) {
    if (verbose || finding.level !== 'ok') {
      console.log(`  [${finding.level}] ${finding.scope}：${finding.message}`);
    }
  }
  console.log(`  通过 ${ok} 项；警告 ${warn} 项；失败 ${fail} 项`);
  if (fail > 0) process.exitCode = 1;
}

/* ------------------------------------------------------------------ pack */

/**
 * 生成可校验的资料交接包（ZIP）：显式包含原件、提取/清洗文本、图片、质量报告、manifest、
 * Wiki、工具与第二阶段文档，并在包内写入 SHA-256 清单。
 * 使用固定时间戳，因此相同输入重复打包会得到字节一致的归档，便于按 SHA-256 复核。
 */
function commandPack(options: Map<string, string[]>): void {
  const outRelative = options.get('out')?.[0] ?? `dist/liuyao-phase2-corpus-${isoTimestampCompact().slice(0, 8)}.zip`;
  const absoluteOut = fromProjectRelative(outRelative);
  ensureDir(path.dirname(absoluteOut));

  const includes = [
    'corpus',
    'wiki',
    'tools',
    'README.md',
    'docs/phase2_development_spec.md',
    'docs/phase2_delivery.md',
    'docs/phase2_acceptance_2026-10-02.md',
  ];
  const collected: Array<{ name: string; data: Buffer }> = [];
  const addFile = (absolutePath: string): void => {
    const relative = relativeToProject(absolutePath);
    if (relative.startsWith('dist/') || relative === 'docs/phase2_pack_inventory.md') return;
    collected.push({ name: relative, data: fs.readFileSync(absolutePath) });
  };
  const walkPath = (absolutePath: string): void => {
    if (!fs.existsSync(absolutePath)) return;
    if (fs.statSync(absolutePath).isFile()) {
      addFile(absolutePath);
      return;
    }
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      walkPath(path.join(absolutePath, entry.name));
    }
  };
  for (const item of includes) walkPath(fromProjectRelative(item));
  collected.sort((a, b) => a.name.localeCompare(b.name));

  const inventoryLines = collected.map(
    (file) => `${sha256File(fromProjectRelative(file.name))}  ${String(file.data.length).padStart(9, ' ')}  ${file.name}`,
  );
  const packManifest = [
    '# 资料交接包清单（PACK-MANIFEST.txt）',
    '# 说明：本清单不含生成时间，以保证相同输入重复打包得到字节一致的归档（可用 SHA-256 复核）。',
    '# 生成命令：node tools/corpus-cli.ts pack [--out <zip>]',
    `# 文件数：${collected.length}`,
    `# 字节合计：${collected.reduce((sum, file) => sum + file.data.length, 0)}`,
    '# 格式：sha256  字节  项目内相对路径',
    ...inventoryLines,
    '',
  ].join('\n');

  const zipBuffer = createZip([{ name: 'PACK-MANIFEST.txt', data: Buffer.from(packManifest, 'utf8') }, ...collected]);
  fs.writeFileSync(absoluteOut, zipBuffer);
  const zipSha = sha256File(absoluteOut);

  const inventoryDoc = [
    '# 第二阶段资料交接包清单',
    '',
    `- 归档：\`${outRelative}\``,
    `- 归档 SHA-256：\`${zipSha}\``,
    `- 归档字节数：${zipBuffer.length.toLocaleString('en-US')}`,
    `- 内含文件：${collected.length + 1}（含包内 \`PACK-MANIFEST.txt\`）`,
    `- 生成命令：\`node tools/corpus-cli.ts pack --out ${outRelative}\``,
    '- 生成方式：固定时间戳；输入不变则归档字节一致，可用 SHA-256 复核',
    '',
    '## 归档内容（不含包内清单自身）',
    '',
    '```text',
    ...inventoryLines,
    '```',
    '',
    '> `corpus/originals/` 因体积与第三方版权原因不进入 Git，但**必须**通过本归档交付；' +
      '归档内的 `PACK-MANIFEST.txt` 与本文件互为核对依据。',
    '',
  ].join('\n');
  writeText(fromProjectRelative('docs/phase2_pack_inventory.md'), inventoryDoc);

  console.log(`交接包：${outRelative}`);
  console.log(`  SHA-256：${zipSha}`);
  console.log(`  文件数：${collected.length + 1}；字节：${zipBuffer.length.toLocaleString('en-US')}`);
  console.log('  清单：docs/phase2_pack_inventory.md');
}

/* ------------------------------------------------------------------ status */

function commandStatus(): void {
  const manifest = readManifest();
  console.log(`来源数：${manifest.length}`);
  console.log('');
  console.log('| source_id | 角色/格式 | 覆盖 | 质量 | 提取 | 清洗 | 图片 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const source of manifest) {
    console.log(
      `| \`${source.source_id}\` | ${sourceRole(source)} / ${source.format} | ${source.coverage.processedUnits || '-'} | ${source.coverage.quality} | ` +
        `${source.processing.extractedPath ? '有' : '无'} | ${source.processing.cleanedPath ? '有' : '无'} | ${source.processing.assetPaths.length} |`,
    );
  }
  const totalBytes = manifest.reduce((sum, item) => sum + item.sizeBytes, 0);
  console.log('');
  console.log(`原件合计 ${totalBytes.toLocaleString('en-US')} 字节；manifest：${relativeToProject(manifestPath)}`);
}

/* ------------------------------------------------------------------ main */

const { command, options } = parseOptions(process.argv.slice(2));
const commands: Record<string, () => void> = {
  import: commandImport,
  extract: () => commandExtract(options),
  ocr: () => commandOcr(options),
  assets: () => commandAssets(options),
  clean: () => commandClean(options),
  report: () => commandReport(options),
  pack: () => commandPack(options),
  verify: commandVerify,
  status: commandStatus,
};

const handler = commands[command];
if (!handler) {
  console.error(`未知命令：${command}\n可用命令：${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
handler();
