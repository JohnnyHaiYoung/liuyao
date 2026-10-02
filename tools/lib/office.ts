/**
 * Office format readers implemented with Node built-ins only.
 *
 * Why not a library: this machine has no pip (PyPI unreachable), no LibreOffice and no
 * antiword/catdoc; Word COM automation hangs in this sandbox. The two formats needed here are
 * OOXML (a ZIP with XML inside) and Word 97-2003 binary (.doc, an OLE compound file with a
 * piece table), both of which are small, documented and implementable without dependencies.
 */
import zlib from 'node:zlib';

/* ------------------------------------------------------------------ ZIP (for DOCX) */

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  content: Buffer;
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Minimal ZIP reader: central directory + stored/deflated entries (OOXML never uses others). */
export function readZip(buffer: Buffer): ZipEntry[] {
  // End of central directory: scan the tail for the 0x06054b50 signature.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 66_000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/DOCX：找不到中央目录结尾记录');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 的 DOCX');
  }

  const entries: CentralEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`中央目录记录损坏 @${offset}`);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const result: ZipEntry[] = [];
  for (const entry of entries) {
    const isDirectory = entry.name.endsWith('/');
    const local = entry.localHeaderOffset;
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`本地文件头损坏：${entry.name}`);
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    let content: Buffer;
    if (entry.method === 0) content = Buffer.from(data);
    else if (entry.method === 8) content = zlib.inflateRawSync(data);
    else throw new Error(`不支持的压缩方法 ${entry.method}（${entry.name}）`);
    result.push({ name: entry.name, isDirectory, content });
  }
  return result;
}

/* ------------------------------------------------------------------ DOCX */

export interface DocxBlock {
  kind: 'heading' | 'paragraph' | 'table';
  text: string;
  /** Table rows for kind=table. */
  rows?: string[][];
}

export interface DocxDocument {
  blocks: DocxBlock[];
  paragraphCount: number;
  tableCount: number;
  mediaFiles: Array<{ name: string; content: Buffer }>;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Extract the visible text of one <w:p> element, honouring <w:t>, <w:tab/>, <w:br/>, <w:drawing/>. */
function paragraphText(xml: string): { text: string; hasImage: boolean } {
  let text = '';
  let hasImage = false;
  const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:drawing>|<w:pict>/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(xml)) !== null) {
    if (match[1] !== undefined) text += decodeXmlEntities(match[1]);
    else if (match[0].startsWith('<w:tab')) text += '\t';
    else if (match[0].startsWith('<w:br')) text += '\n';
    else hasImage = true;
  }
  if (hasImage) text = `${text}${text === '' ? '' : ' '}[图片]`;
  return { text: text.trim(), hasImage };
}

/**
 * Walk word/document.xml in document order so paragraphs and tables keep their sequence.
 * Headings are detected from <w:pStyle w:val="...HeadingN"> (falling back to 标题N).
 */
export function readDocx(buffer: Buffer): DocxDocument {
  const entries = readZip(buffer);
  const documentEntry = entries.find((entry) => entry.name === 'word/document.xml');
  if (!documentEntry) throw new Error('DOCX 缺少 word/document.xml');
  const xml = documentEntry.content.toString('utf8');

  const blocks: DocxBlock[] = [];
  let paragraphCount = 0;
  let tableCount = 0;

  // Split the body into top-level paragraphs and tables by scanning sequentially.
  const bodyMatch = /<w:body>([\s\S]*)<\/w:body>/.exec(xml);
  const body = bodyMatch ? bodyMatch[1] : xml;
  const topLevel = /<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>|<w:tbl>[\s\S]*?<\/w:tbl>/g;
  let match: RegExpExecArray | null;
  while ((match = topLevel.exec(body)) !== null) {
    const chunk = match[0];
    if (chunk.startsWith('<w:tbl>')) {
      const rows: string[][] = [];
      const rowPattern = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      let rowMatch: RegExpExecArray | null;
      while ((rowMatch = rowPattern.exec(chunk)) !== null) {
        const cells: string[] = [];
        const cellPattern = /<w:tc>([\s\S]*?)<\/w:tc>/g;
        let cellMatch: RegExpExecArray | null;
        while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
          const cellParagraphs = cellMatch[1].match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? [];
          const cellText = cellParagraphs
            .map((paragraph) => paragraphText(paragraph).text)
            .filter((value) => value !== '')
            .join(' ');
          cells.push(cellText);
        }
        if (cells.length > 0) rows.push(cells);
      }
      if (rows.length > 0) {
        tableCount += 1;
        blocks.push({ kind: 'table', text: rows.map((row) => row.join(' | ')).join('\n'), rows });
      }
      continue;
    }
    paragraphCount += 1;
    const styleMatch = /<w:pStyle\s+w:val="([^"]+)"/.exec(chunk);
    const style = styleMatch ? styleMatch[1] : '';
    const { text } = paragraphText(chunk);
    if (text === '') continue;
    const isHeading = /(?:^|[^a-z])(heading|Heading|标题)\s*[1-6]?/.test(style) || /^(?:Heading|标题)\d/.test(style);
    blocks.push({ kind: isHeading ? 'heading' : 'paragraph', text });
  }

  const mediaFiles = entries
    .filter((entry) => entry.name.startsWith('word/media/') && !entry.isDirectory)
    .map((entry) => ({ name: entry.name.replace('word/media/', ''), content: entry.content }));

  return { blocks, paragraphCount, tableCount, mediaFiles };
}

/* ------------------------------------------------------------------ OLE compound file (.doc) */

interface DirectoryEntry {
  name: string;
  type: number;
  startSector: number;
  streamSize: number;
}

export interface OleFile {
  streams: Map<string, Buffer>;
  list(): string[];
}

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/**
 * Read an OLE2/CFB container (Word 97-2003 .doc). Handles the main FAT and the mini-stream,
 * which is where streams smaller than 4096 bytes live (the table stream often is).
 */
export function readOle(buffer: Buffer): OleFile {
  if (buffer.readUInt32LE(0) !== 0xe011cfd0 || buffer.readUInt32LE(4) !== 0xe11ab1a1) {
    throw new Error('不是 OLE2 复合文档（可能不是旧版 Word .doc）');
  }
  const sectorShift = buffer.readUInt16LE(0x1e);
  const miniSectorShift = buffer.readUInt16LE(0x20);
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  const fatSectorCount = buffer.readUInt32LE(0x2c);
  const firstDirectorySector = buffer.readUInt32LE(0x30);
  const miniStreamCutoff = buffer.readUInt32LE(0x38);
  const firstMiniFatSector = buffer.readUInt32LE(0x3c);
  const miniFatSectorCount = buffer.readUInt32LE(0x40);
  const firstDifatSector = buffer.readUInt32LE(0x44);
  const difatSectorCount = buffer.readUInt32LE(0x48);

  const sectorOffset = (sector: number): number => (sector + 1) * sectorSize;

  // DIFAT: the first 109 entries live in the header, the rest in chained sectors.
  const difat: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    const value = buffer.readUInt32LE(0x4c + index * 4);
    if (value !== FREESECT) difat.push(value);
  }
  let difatSector = firstDifatSector;
  for (let guard = 0; guard < difatSectorCount && difatSector !== ENDOFCHAIN && difatSector !== FREESECT; guard += 1) {
    const base = sectorOffset(difatSector);
    const entries = sectorSize / 4 - 1;
    for (let index = 0; index < entries; index += 1) {
      const value = buffer.readUInt32LE(base + index * 4);
      if (value !== FREESECT) difat.push(value);
    }
    difatSector = buffer.readUInt32LE(base + sectorSize - 4);
  }

  const fat: number[] = [];
  for (let index = 0; index < fatSectorCount && index < difat.length; index += 1) {
    const base = sectorOffset(difat[index]!);
    for (let entry = 0; entry < sectorSize / 4; entry += 1) fat.push(buffer.readUInt32LE(base + entry * 4));
  }

  const readChain = (startSector: number, size: number, table: number[], sectorBytes: number, offsetOf: (sector: number) => number): Buffer => {
    const chunks: Buffer[] = [];
    let sector = startSector;
    let remaining = size;
    let guard = 0;
    while (sector !== ENDOFCHAIN && sector !== FREESECT && remaining > 0 && guard < 1_000_000) {
      const start = offsetOf(sector);
      const length = Math.min(sectorBytes, remaining);
      chunks.push(buffer.subarray(start, start + length));
      remaining -= length;
      sector = table[sector] ?? ENDOFCHAIN;
      guard += 1;
    }
    return Buffer.concat(chunks);
  };

  // Directory entries: 128 bytes each.
  const directoryBuffer = readChain(firstDirectorySector, Number.MAX_SAFE_INTEGER, fat, sectorSize, sectorOffset);
  const directories: DirectoryEntry[] = [];
  for (let offset = 0; offset + 128 <= directoryBuffer.length; offset += 128) {
    const nameLength = directoryBuffer.readUInt16LE(offset + 64);
    const type = directoryBuffer[offset + 66];
    if (type === 0) continue;
    const name = directoryBuffer.subarray(offset, offset + Math.max(0, nameLength - 2)).toString('utf16le');
    directories.push({
      name,
      type,
      startSector: directoryBuffer.readUInt32LE(offset + 116),
      streamSize: directoryBuffer.readUInt32LE(offset + 120),
    });
  }

  const root = directories.find((entry) => entry.type === 5);
  const miniFat: number[] = [];
  if (miniFatSectorCount > 0 && firstMiniFatSector !== ENDOFCHAIN) {
    const miniFatBuffer = readChain(firstMiniFatSector, miniFatSectorCount * sectorSize, fat, sectorSize, sectorOffset);
    for (let index = 0; index + 4 <= miniFatBuffer.length; index += 4) miniFat.push(miniFatBuffer.readUInt32LE(index));
  }
  const miniStream = root ? readChain(root.startSector, root.streamSize, fat, sectorSize, sectorOffset) : Buffer.alloc(0);
  const miniOffsetOf = (sector: number): number => sector * miniSectorSize;

  const streams = new Map<string, Buffer>();
  for (const entry of directories) {
    if (entry.type !== 2) continue;
    const content =
      entry.streamSize < miniStreamCutoff && miniStream.length > 0
        ? readChain(entry.startSector, entry.streamSize, miniFat, miniSectorSize, miniOffsetOf)
        : readChain(entry.startSector, entry.streamSize, fat, sectorSize, sectorOffset);
    streams.set(entry.name, content);
  }

  return { streams, list: () => [...streams.keys()] };
}

/* ------------------------------------------------------------------ Word 97-2003 (.doc) */

export interface LegacyDocResult {
  text: string;
  nFib: number;
  tableStream: string;
  pieceCount: number;
  fWhichTblStm: boolean;
  textEncoding: string;
  paragraphs: number;
  characters: number;
}

/**
 * Extract text from a Word 97-2003 binary document.
 *
 * Algorithm (MS-DOC): read the FIB from the WordDocument stream, locate the CLX (piece table)
 * in the table stream, then decode each piece as either CP1252 (compressed) or UTF-16LE.
 * Documents without a CLX (pre Word 97) fall back to the raw fcMin..fcMac range.
 */
export function readLegacyDoc(buffer: Buffer): LegacyDocResult {
  const ole = readOle(buffer);
  const wordDocument = ole.streams.get('WordDocument');
  if (!wordDocument) throw new Error(`OLE 容器里没有 WordDocument 流（含：${ole.list().join(', ')}）`);

  const nFib = wordDocument.readUInt16LE(2);
  const flags = wordDocument.readUInt16LE(0x0a);
  const fWhichTblStm = (flags & 0x0200) !== 0;
  const tableStreamName = fWhichTblStm ? '1Table' : '0Table';
  const tableStream = ole.streams.get(tableStreamName) ?? ole.streams.get(fWhichTblStm ? '0Table' : '1Table');
  const fcMin = wordDocument.readUInt32LE(0x18);
  const fcMac = wordDocument.readUInt32LE(0x1c);

  let text = '';
  let pieceCount = 0;
  let usedEncoding = 'utf16le';

  if (tableStream && wordDocument.length >= 0x01aa) {
    const fcClx = wordDocument.readUInt32LE(0x01a2);
    const lcbClx = wordDocument.readUInt32LE(0x01a6);
    if (fcClx + lcbClx <= tableStream.length && lcbClx > 0) {
      const clx = tableStream.subarray(fcClx, fcClx + lcbClx);
      let offset = 0;
      let plcPcd: Buffer | null = null;
      while (offset < clx.length) {
        const kind = clx[offset]!;
        if (kind === 1) {
          const cb = clx.readUInt16LE(offset + 1);
          offset += 3 + cb;
        } else if (kind === 2) {
          const lcb = clx.readUInt32LE(offset + 1);
          plcPcd = clx.subarray(offset + 5, offset + 5 + lcb);
          break;
        } else {
          break;
        }
      }
      if (plcPcd && plcPcd.length >= 4) {
        const n = (plcPcd.length - 4) / 12;
        pieceCount = n;
        const pieces: string[] = [];
        for (let index = 0; index < n; index += 1) {
          const cpStart = plcPcd.readUInt32LE(index * 4);
          const cpEnd = plcPcd.readUInt32LE((index + 1) * 4);
          const pcdOffset = (n + 1) * 4 + index * 8;
          const fcValue = plcPcd.readUInt32LE(pcdOffset + 2);
          const compressed = (fcValue & 0x40000000) !== 0;
          const fc = compressed ? (fcValue & 0x3fffffff) / 2 : fcValue & 0x3fffffff;
          const charCount = cpEnd - cpStart;
          const byteLength = compressed ? charCount : charCount * 2;
          const slice = wordDocument.subarray(fc, fc + byteLength);
          pieces.push(compressed ? slice.toString('latin1') : slice.toString('utf16le'));
          if (compressed) usedEncoding = 'cp1252';
        }
        text = pieces.join('');
      }
    }
  }

  if (text === '' && fcMac > fcMin) {
    text = wordDocument.subarray(fcMin, fcMac).toString('utf16le');
    usedEncoding = 'utf16le(fcMin..fcMac 回退)';
  }

  // Word text uses special control characters; normalise the ones that matter for reading.
  const cleaned = text
    .replace(/\r/g, '\n')
    .replace(/\u0007/g, '\t') // cell/row end
    .replace(/[\u0000-\u0006\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\u0013[\s\S]*?\u0014/g, '') // field instructions
    .replace(/\u0015/g, '');

  return {
    text: cleaned,
    nFib,
    tableStream: tableStreamName,
    pieceCount,
    fWhichTblStm,
    textEncoding: usedEncoding,
    paragraphs: cleaned.split(/\n+/).filter((line) => line.trim() !== '').length,
    characters: cleaned.length,
  };
}
