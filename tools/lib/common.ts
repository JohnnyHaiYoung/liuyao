/**
 * Shared helpers for the corpus tooling: project paths, hashing, JSONL manifests,
 * encoding-aware text reading and locator-friendly text layout.
 *
 * Everything here uses Node built-ins only: the machine has no pip, no LibreOffice,
 * no poppler and no tesseract, so the toolchain must not depend on any package.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(here, '..', '..');
export const corpusDir = path.join(projectRoot, 'corpus');
export const originalsDir = path.join(corpusDir, 'originals');
export const extractedDir = path.join(corpusDir, 'extracted');
export const cleanedDir = path.join(corpusDir, 'cleaned');
export const assetsDir = path.join(corpusDir, 'assets');
export const reportsDir = path.join(corpusDir, 'reports');
export const manifestPath = path.join(corpusDir, 'manifest.jsonl');
export const wikiDir = path.join(projectRoot, 'wiki');
export const storageDir = path.join(projectRoot, 'storage');
export const toolsDir = path.join(projectRoot, 'tools');

/** F: drive root used only as an import source + audit record, never at runtime. */
export const sourceDriveRoot = 'F:\\道教\\六爻';
/** Windows paths inside the project must stay relative in every artefact. */
export function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
export function relativeToProject(absolutePath: string): string {
  return toPosix(path.relative(projectRoot, absolutePath));
}
export function fromProjectRelative(relativePath: string): string {
  return path.join(projectRoot, ...relativePath.split('/'));
}
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
export function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}
export function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
/** Locator ids must be stable across re-runs of the same original. */
export function stableId(...parts: Array<string | number>): string {
  return sha256Text(parts.join('|')).slice(0, 12);
}
export function nowIso(): string {
  return new Date().toISOString();
}
export function isoTimestampCompact(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/* ------------------------------------------------------------------ manifest */

export interface ManifestSource {
  source_id: string;
  sha256: string;
  sizeBytes: number;
  format: string;
  extension: string;
  discoveredAt: string;
  sourceRelativePathFromF: string;
  originalRelativePath: string;
  aliasSourcePaths?: string[];
  duplicateOf?: string | null;
  suspectedVersionRelation?: string | null;
  processing: {
    status: 'pending' | 'processed' | 'failed';
    inputEncoding: string | null;
    extractor: string | null;
    extractorVersion: string | null;
    ocrLanguage: string | null;
    processedAt: string | null;
    extractedPath: string | null;
    cleanedPath: string | null;
    assetPaths: string[];
    tools: Array<{ name: string; version: string; command: string }>;
  };
  coverage: {
    structureSummary: string;
    totalUnits: string;
    processedUnits: string;
    unprocessedUnits: string | null;
    quality: 'usable' | 'needs_review' | 'failed';
    issues: string[];
    pageCount?: number | null;
    processedPages?: string | null;
  };
  notes: string[];
}

export function readManifest(): ManifestSource[] {
  if (!fs.existsSync(manifestPath)) return [];
  return fs
    .readFileSync(manifestPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ManifestSource);
}

export function writeManifest(sources: ManifestSource[]): void {
  const sorted = [...sources].sort((a, b) => a.source_id.localeCompare(b.source_id));
  const body = sorted.map((source) => JSON.stringify(source)).join('\n');
  ensureDir(corpusDir);
  fs.writeFileSync(manifestPath, `${body}\n`, 'utf8');
}

export function upsertManifest(entry: ManifestSource): ManifestSource {
  const sources = readManifest();
  const index = sources.findIndex((item) => item.source_id === entry.source_id);
  if (index >= 0) sources[index] = entry;
  else sources.push(entry);
  writeManifest(sources);
  return entry;
}

/* ------------------------------------------------------------------ encodings */

export interface DecodedText {
  text: string;
  encoding: string;
  hadBom: boolean;
  replacementChars: number;
  confidence: 'high' | 'medium' | 'low';
  candidates: Array<{ encoding: string; replacementChars: number; controlChars: number }>;
}

/**
 * Decode a text file trying the encodings actually seen in this corpus (UTF-8 with/without
 * BOM, GB18030, Big5). Pick the candidate with the fewest replacement and control characters;
 * GB18030 is a superset of GBK/GB2312 and also decodes ASCII, so it is tried before Big5.
 */
export function decodeTextBuffer(buffer: Buffer): DecodedText {
  const hadBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const candidates: Array<{ encoding: string; replacementChars: number; controlChars: number; text: string }> = [];
  for (const encoding of ['utf-8', 'gb18030', 'big5']) {
    let text = '';
    try {
      text = new TextDecoder(encoding, { fatal: false }).decode(buffer);
    } catch {
      continue;
    }
    let replacementChars = 0;
    let controlChars = 0;
    for (const char of text) {
      if (char === '\uFFFD') replacementChars += 1;
      else if (char < ' ' && char !== '\n' && char !== '\r' && char !== '\t') controlChars += 1;
    }
    candidates.push({ encoding, replacementChars, controlChars, text });
  }
  candidates.sort((a, b) => a.replacementChars - b.replacementChars || a.controlChars - b.controlChars);
  const best = candidates[0];
  if (!best) {
    return {
      text: buffer.toString('latin1'),
      encoding: 'latin1',
      hadBom,
      replacementChars: 0,
      confidence: 'low',
      candidates: [],
    };
  }
  const confidence: DecodedText['confidence'] =
    best.replacementChars === 0 && best.controlChars === 0
      ? 'high'
      : best.replacementChars / Math.max(1, best.text.length) < 0.001
        ? 'medium'
        : 'low';
  return {
    text: best.text,
    encoding: best.encoding,
    hadBom,
    replacementChars: best.replacementChars,
    confidence,
    candidates: candidates.map(({ encoding, replacementChars, controlChars }) => ({ encoding, replacementChars, controlChars })),
  };
}

/* ------------------------------------------------------------------ text layout */

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** Windows OCR inserts a space between every CJK glyph; drop spaces between CJK chars only. */
export function collapseCjkSpaces(value: string): string {
  return value.replace(/([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g, '$1');
}

export function normalizeFullWidthSpaces(value: string): string {
  return value.replace(/\u3000/g, ' ').replace(/[ \t]+$/gm, '');
}

/**
 * Split text into paragraphs. Headings and short single-line paragraphs are kept separate so
 * locators ("段落起始语") stay stable and greppable in the cleaned markdown.
 */
export function splitParagraphs(value: string, options: { minLength?: number } = {}): string[] {
  const minLength = options.minLength ?? 1;
  const blocks = normalizeNewlines(value)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '');
  const paragraphs: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    if (lines.length <= 1) {
      if (lines[0] && lines[0].length >= minLength) paragraphs.push(lines[0]);
      continue;
    }
    // Keep hard-wrapped lines from a scanned page together, but break on heading-ish lines.
    let current = '';
    for (const line of lines) {
      const looksLikeHeading = line.length <= 24 && /[：:。！？]$/.test(line) === false && /\s/.test(line) === false;
      if (looksLikeHeading && current !== '') {
        paragraphs.push(current.trim());
        current = line;
        continue;
      }
      current = current === '' ? line : `${current}${current.endsWith('，') || current.endsWith('。') ? '' : ''}${line}`;
    }
    if (current.trim() !== '') paragraphs.push(current.trim());
  }
  return paragraphs.filter((paragraph) => paragraph.length >= minLength);
}

export function countCjk(value: string): number {
  const matches = value.match(/[\u4e00-\u9fff]/g);
  return matches ? matches.length : 0;
}

export interface ProcessedTextStats {
  chars: number;
  cjkChars: number;
  paragraphs: number;
  replacementChars: number;
  longestParagraph: number;
}

export function textStats(value: string, paragraphs: string[]): ProcessedTextStats {
  let replacementChars = 0;
  for (const char of value) if (char === '\uFFFD') replacementChars += 1;
  return {
    chars: value.length,
    cjkChars: countCjk(value),
    paragraphs: paragraphs.length,
    replacementChars,
    longestParagraph: paragraphs.reduce((max, paragraph) => Math.max(max, paragraph.length), 0),
  };
}

/** Find a paragraph index by its opening words; used to verify wiki locators. */
export function findParagraphIndex(paragraphs: string[], locator: string): number {
  const needle = collapseCjkSpaces(locator).replace(/\s+/g, '');
  return paragraphs.findIndex((paragraph) => paragraph.replace(/\s+/g, '').includes(needle));
}
