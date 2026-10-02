/**
 * Minimal but real PDF reader: object scanning, Flate streams, font ToUnicode CMaps and
 * page-level text extraction with locators. Written for this corpus (small, Flate-compressed,
 * Identity-H CID fonts with ToUnicode); it is deliberately tolerant — anything it cannot
 * decode is reported per page instead of being silently dropped.
 *
 * Not implemented on purpose (documented as a known gap): encrypted PDFs, JPXDecode/JBIG2
 * images, and glyph reconstruction when a font has no ToUnicode CMap.
 */
import zlib from 'node:zlib';

export interface PdfObject {
  number: number;
  generation: number;
  offset: number;
  dict: string;
  /** Raw (still filtered) stream bytes, when the object has one. */
  rawStream: Buffer | null;
}

export interface PdfPage {
  index: number;
  objectNumber: number;
  text: string;
  chars: number;
  hasTextLayer: boolean;
  errors: string[];
  width: number | null;
  height: number | null;
}

export interface PdfImageInfo {
  objectNumber: number;
  width: number | null;
  height: number | null;
  filter: string | null;
  bitsPerComponent: number | null;
  colorSpace: string | null;
}

export interface PdfDocument {
  version: string;
  pageCount: number;
  pages: PdfPage[];
  images: PdfImageInfo[];
  fonts: Array<{ name: string; subtype: string | null; hasToUnicode: boolean }>;
  notes: string[];
}

const STREAM_END = Buffer.from('endstream', 'latin1');

function inflate(buffer: Buffer): Buffer | null {
  try {
    return zlib.inflateSync(buffer);
  } catch {
    try {
      return zlib.inflateRawSync(buffer);
    } catch {
      return null;
    }
  }
}

function decodePdfString(raw: string): string {
  // Handles (..) escapes and <hex> strings; byte-to-text mapping happens later per font.
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/[^0-9a-fA-F]/g, '');
    const padded = hex.length % 2 === 1 ? `${hex}0` : hex;
    let out = '';
    for (let index = 0; index < padded.length; index += 2) {
      out += String.fromCharCode(Number.parseInt(padded.slice(index, index + 2), 16));
    }
    return out;
  }
  const body = raw.slice(1, -1);
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '(' || next === ')' || next === '\\') out += next;
    else if (next >= '0' && next <= '7') {
      let oct = next;
      let consumed = 1;
      while (consumed < 3 && body[index + 1 + consumed] >= '0' && body[index + 1 + consumed] <= '7') {
        oct += body[index + 1 + consumed];
        consumed += 1;
      }
      out += String.fromCharCode(Number.parseInt(oct, 8));
      index += consumed - 1;
    } else if (next === '\n') {
      // line continuation
    } else out += next;
    index += 1;
  }
  return out;
}

/** Parse a ToUnicode CMap stream into a code -> string map (bfchar + bfrange). */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  let match: RegExpExecArray | null;
  while ((match = bfchar.exec(cmap)) !== null) {
    const pairPattern = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
    let pair: RegExpExecArray | null;
    while ((pair = pairPattern.exec(match[1]!)) !== null) {
      const code = Number.parseInt(pair[1]!, 16);
      map.set(code, hexToText(pair[2]!));
    }
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((match = bfrange.exec(cmap)) !== null) {
    const rangePattern = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([\s\S]*?)\])/g;
    let range: RegExpExecArray | null;
    while ((range = rangePattern.exec(match[1]!)) !== null) {
      const start = Number.parseInt(range[1]!, 16);
      const end = Number.parseInt(range[2]!, 16);
      if (range[3] !== undefined) {
        const base = hexToText(range[3]);
        const baseCode = base.codePointAt(0) ?? 0;
        for (let code = start; code <= end && code - start < 65536; code += 1) {
          map.set(code, String.fromCodePoint(baseCode + (code - start)));
        }
      } else if (range[4] !== undefined) {
        const items = range[4].match(/<([0-9a-fA-F]*)>/g) ?? [];
        items.forEach((item, index) => {
          const code = start + index;
          if (code <= end) map.set(code, hexToText(item.slice(1, -1)));
        });
      }
    }
  }
  return map;
}

function hexToText(hex: string): string {
  let out = '';
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  for (let index = 0; index + 4 <= clean.length; index += 4) {
    out += String.fromCharCode(Number.parseInt(clean.slice(index, index + 4), 16));
  }
  if (clean.length % 4 === 2) out += String.fromCharCode(Number.parseInt(clean.slice(-2), 16));
  return out;
}

/** Split a PDF content stream into tokens (numbers, names, strings, arrays, operators). */
function tokenize(content: string): Array<{ type: 'num' | 'name' | 'str' | 'arr' | 'op'; value: string | number | unknown[] }> {
  const tokens: Array<{ type: 'num' | 'name' | 'str' | 'arr' | 'op'; value: string | number | unknown[] }> = [];
  let index = 0;
  const length = content.length;
  while (index < length) {
    const char = content[index]!;
    if (char === '%') {
      while (index < length && content[index] !== '\n') index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/') {
      let name = '';
      index += 1;
      while (index < length && !/[\s/\[\]<>()]/.test(content[index]!)) {
        name += content[index];
        index += 1;
      }
      tokens.push({ type: 'name', value: name });
      continue;
    }
    if (char === '(') {
      let depth = 1;
      let raw = '(';
      index += 1;
      while (index < length && depth > 0) {
        const current = content[index]!;
        raw += current;
        if (current === '\\') {
          raw += content[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (current === '(') depth += 1;
        else if (current === ')') depth -= 1;
        index += 1;
      }
      tokens.push({ type: 'str', value: raw });
      continue;
    }
    if (char === '<' && content[index + 1] !== '<') {
      let raw = '<';
      index += 1;
      while (index < length && content[index] !== '>') {
        raw += content[index];
        index += 1;
      }
      raw += '>';
      index += 1;
      tokens.push({ type: 'str', value: raw });
      continue;
    }
    if (char === '[') {
      const items: unknown[] = [];
      index += 1;
      while (index < length && content[index] !== ']') {
        const current = content[index]!;
        if (/\s/.test(current)) {
          index += 1;
          continue;
        }
        if (current === '(') {
          let depth = 1;
          let raw = '(';
          index += 1;
          while (index < length && depth > 0) {
            const inner = content[index]!;
            raw += inner;
            if (inner === '\\') {
              raw += content[index + 1] ?? '';
              index += 2;
              continue;
            }
            if (inner === '(') depth += 1;
            else if (inner === ')') depth -= 1;
            index += 1;
          }
          items.push(raw);
          continue;
        }
        if (current === '<') {
          let raw = '<';
          index += 1;
          while (index < length && content[index] !== '>') {
            raw += content[index];
            index += 1;
          }
          raw += '>';
          index += 1;
          items.push(raw);
          continue;
        }
        let raw = '';
        while (index < length && !/[\s\[\]()<>]/.test(content[index]!)) {
          raw += content[index];
          index += 1;
        }
        if (raw !== '') items.push(raw);
        else index += 1;
      }
      index += 1;
      tokens.push({ type: 'arr', value: items });
      continue;
    }
    if (char === '<' && content[index + 1] === '<') {
      // Inline dictionary: skip to the matching '>>' (used by BDC/DP).
      let depth = 0;
      while (index < length) {
        if (content[index] === '<' && content[index + 1] === '<') {
          depth += 1;
          index += 2;
          continue;
        }
        if (content[index] === '>' && content[index + 1] === '>') {
          depth -= 1;
          index += 2;
          if (depth <= 0) break;
          continue;
        }
        index += 1;
      }
      continue;
    }
    let raw = '';
    while (index < length && !/[\s\[\]()<>/]/.test(content[index]!)) {
      raw += content[index];
      index += 1;
    }
    if (raw === '') {
      index += 1;
      continue;
    }
    if (/^[-+]?[\d.]+$/.test(raw)) tokens.push({ type: 'num', value: Number.parseFloat(raw) });
    else tokens.push({ type: 'op', value: raw });
  }
  return tokens;
}

export function readPdf(buffer: Buffer): PdfDocument {
  const latin = buffer.toString('latin1');
  const notes: string[] = [];
  const version = /^%PDF-(\d\.\d)/.exec(latin)?.[1] ?? 'unknown';

  // Object scanning: tolerate broken xref tables (common in re-saved Chinese ebooks).
  const objects = new Map<number, PdfObject>();
  const objectPattern = /(\d+)\s+(\d+)\s+obj\b/g;
  const starts: Array<{ number: number; generation: number; offset: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = objectPattern.exec(latin)) !== null) {
    starts.push({ number: Number.parseInt(match[1]!, 10), generation: Number.parseInt(match[2]!, 10), offset: match.index });
  }
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index]!;
    const nextOffset = index + 1 < starts.length ? starts[index + 1]!.offset : buffer.length;
    const segment = buffer.subarray(current.offset, nextOffset);
    const segmentText = segment.toString('latin1');
    const endObj = segmentText.indexOf('endobj');
    const body = endObj >= 0 ? segmentText.slice(0, endObj) : segmentText;
    const streamIndex = body.indexOf('stream');
    let dict = body;
    let rawStream: Buffer | null = null;
    if (streamIndex >= 0) {
      dict = body.slice(0, streamIndex);
      const streamStartInSegment = streamIndex + 'stream'.length + (body[streamIndex + 6] === '\r' ? 2 : body[streamIndex + 6] === '\n' ? 1 : 0);
      const absoluteStart = current.offset + streamStartInSegment;
      let absoluteEnd = buffer.indexOf(STREAM_END, absoluteStart);
      if (absoluteEnd < 0) absoluteEnd = nextOffset;
      rawStream = buffer.subarray(absoluteStart, absoluteEnd);
    }
    objects.set(current.number, {
      number: current.number,
      generation: current.generation,
      offset: current.offset,
      dict,
      rawStream,
    });
  }

  /** Resolve a stream's decoded bytes, following a single FlateDecode filter. */
  const streamOf = (object: PdfObject | undefined): Buffer | null => {
    if (!object?.rawStream) return null;
    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(object.dict)?.[1] ?? '';
    if (filter.includes('FlateDecode') || filter === '') {
      const inflated = inflate(object.rawStream);
      if (inflated) return inflated;
      if (filter.includes('FlateDecode')) {
        notes.push(`对象 ${object.number} 的 FlateDecode 解压失败`);
        return null;
      }
    }
    return object.rawStream;
  };

  const refNumbers = (value: string | undefined): number[] => {
    if (!value) return [];
    return [...value.matchAll(/(\d+)\s+\d+\s+R/g)].map((item) => Number.parseInt(item[1]!, 10));
  };

  // Page order: walk the page tree from the catalog; fall back to file order if it is broken.
  const pageOrder: number[] = [];
  const catalog = [...objects.values()].find((object) => /\/Type\s*\/Catalog/.test(object.dict));
  const visited = new Set<number>();
  const walk = (objectNumber: number): void => {
    if (visited.has(objectNumber) || visited.size > 5000) return;
    visited.add(objectNumber);
    const object = objects.get(objectNumber);
    if (!object) return;
    if (/\/Type\s*\/Page[^s]/.test(object.dict)) {
      pageOrder.push(objectNumber);
      return;
    }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(object.dict)?.[1];
    for (const child of refNumbers(kids)) walk(child);
  };
  const pagesRoot = catalog ? refNumbers(/\/Pages\s+(\d+\s+\d+\s+R)/.exec(catalog.dict)?.[1])[0] : undefined;
  if (pagesRoot !== undefined) walk(pagesRoot);
  if (pageOrder.length === 0) {
    notes.push('页面树遍历失败，退化为按文件顺序排列 /Type /Page');
    for (const [number, object] of objects) {
      if (/\/Type\s*\/Page[^s]/.test(object.dict)) pageOrder.push(number);
    }
  }

  // Fonts: collect subtype and ToUnicode availability for the report.
  const fontMaps = new Map<number, Map<number, string>>();
  const fonts: PdfDocument['fonts'] = [];
  for (const [number, object] of objects) {
    if (!/\/Type\s*\/Font/.test(object.dict)) continue;
    const subtype = /\/Subtype\s*\/(\w+)/.exec(object.dict)?.[1] ?? null;
    const toUnicodeRef = refNumbers(/\/ToUnicode\s+(\d+\s+\d+\s+R)/.exec(object.dict)?.[1])[0];
    let cmap: Map<number, string> | null = null;
    if (toUnicodeRef !== undefined) {
      const cmapBuffer = streamOf(objects.get(toUnicodeRef));
      if (cmapBuffer) cmap = parseToUnicode(cmapBuffer.toString('latin1'));
    }
    if (cmap) fontMaps.set(number, cmap);
    fonts.push({ name: `/F${number}`, subtype, hasToUnicode: Boolean(cmap) });
  }

  const pages: PdfPage[] = [];
  pageOrder.forEach((pageObjectNumber, pageIndex) => {
    const pageObject = objects.get(pageObjectNumber);
    const errors: string[] = [];
    let text = '';
    let width: number | null = null;
    let height: number | null = null;
    if (pageObject) {
      const mediaBox = /\/MediaBox\s*\[([^\]]*)\]/.exec(pageObject.dict)?.[1];
      if (mediaBox) {
        const values = mediaBox.trim().split(/\s+/).map((value) => Number.parseFloat(value));
        if (values.length === 4) {
          width = values[2]! - values[0]!;
          height = values[3]! - values[1]!;
        }
      }
      // Font resources for this page (may be inherited from /Pages in theory; not needed here).
      const fontResources = new Map<string, Map<number, string> | null>();
      const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(pageObject.dict)?.[1] ?? '';
      for (const fontMatch of fontDict.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
        const fontObjectNumber = Number.parseInt(fontMatch[2]!, 10);
        fontResources.set(fontMatch[1]!, fontMaps.get(fontObjectNumber) ?? null);
      }

      const contentRefs = [
        ...refNumbers(/\/Contents\s+(\d+\s+\d+\s+R)/.exec(pageObject.dict)?.[1]),
        ...refNumbers(/\/Contents\s*\[([^\]]*)\]/.exec(pageObject.dict)?.[1]),
      ];
      const chunks: Buffer[] = [];
      for (const reference of contentRefs) {
        const decoded = streamOf(objects.get(reference));
        if (decoded) chunks.push(decoded);
      }
      if (chunks.length === 0) errors.push('未找到可解码的内容流');
      const content = Buffer.concat(chunks).toString('latin1');

      const tokens = tokenize(content);
      let currentFont: Map<number, string> | null = null;
      let currentFontIsCid = false;
      let pending: Array<string | number> = [];
      let lastY: number | null = null;
      let inText = false;
      let line = '';

      /**
       * Turn a PDF string token into raw bytes.
       * `<0747...>` is hex and MUST be hex-decoded (this is how CID fonts carry text);
       * `(...)` is a literal byte string with backslash escapes.
       */
      const decodeBytes = (raw: string): number[] => {
        const bytes: number[] = [];
        if (raw.startsWith('<')) {
          const hex = raw.slice(1, -1).replace(/[^0-9a-fA-F]/g, '');
          const padded = hex.length % 2 === 1 ? `${hex}0` : hex;
          for (let index = 0; index < padded.length; index += 2) {
            bytes.push(Number.parseInt(padded.slice(index, index + 2), 16));
          }
          return bytes;
        }
        const body = raw.startsWith('(') ? raw.slice(1, -1) : raw;
        for (let index = 0; index < body.length; index += 1) {
          const char = body[index]!;
          if (char !== '\\') {
            bytes.push(char.charCodeAt(0) & 0xff);
            continue;
          }
          const next = body[index + 1];
          if (next === undefined) break;
          index += 1;
          if (next === 'n') bytes.push(10);
          else if (next === 'r') bytes.push(13);
          else if (next === 't') bytes.push(9);
          else if (next === 'b') bytes.push(8);
          else if (next === 'f') bytes.push(12);
          else if (next === '\n') continue; // line continuation
          else if (next >= '0' && next <= '7') {
            let oct = next;
            while (oct.length < 3 && body[index + 1] >= '0' && body[index + 1] <= '7') {
              oct += body[index + 1];
              index += 1;
            }
            bytes.push(Number.parseInt(oct, 8) & 0xff);
          } else bytes.push(next.charCodeAt(0) & 0xff);
        }
        return bytes;
      };

      const decodeShow = (raw: string): string => {
        const bytes = decodeBytes(raw);
        if (!currentFont) {
          return bytes.map((byte) => String.fromCharCode(byte)).join('');
        }
        let out = '';
        if (currentFontIsCid) {
          for (let index = 0; index + 1 < bytes.length; index += 2) {
            const code = (bytes[index]! << 8) | bytes[index + 1]!;
            out += currentFont.get(code) ?? '';
          }
        } else {
          for (const byte of bytes) out += currentFont.get(byte) ?? String.fromCharCode(byte);
        }
        return out;
      };

      const flushLine = (): void => {
        if (line.trim() !== '') text += `${line.trim()}\n`;
        line = '';
      };

      for (const token of tokens) {
        if (token.type === 'op') {
          const operator = String(token.value);
          switch (operator) {
            case 'BT':
              inText = true;
              break;
            case 'ET':
              flushLine();
              inText = false;
              lastY = null;
              break;
            case 'Tf': {
              const fontName = pending.length >= 2 ? String(pending[pending.length - 2]) : '';
              const font = fontResources.get(fontName.replace(/^\//, '')) ?? null;
              currentFont = font;
              const fontObject = [...fontDict.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)].find((item) => item[1] === fontName.replace(/^\//, ''));
              const subtype = fontObject ? /\/Subtype\s*\/(\w+)/.exec(objects.get(Number.parseInt(fontObject[2]!, 10))?.dict ?? '')?.[1] : undefined;
              currentFontIsCid = subtype === 'Type0';
              break;
            }
            case 'Td':
            case 'TD': {
              const y = pending.length >= 2 ? Number(pending[pending.length - 1]) : 0;
              if (inText && lastY !== null && Math.abs(y - lastY) > 0.01) flushLine();
              lastY = y;
              break;
            }
            case 'Tm': {
              const y = pending.length >= 6 ? Number(pending[pending.length - 1]) : 0;
              if (inText && lastY !== null && Math.abs(y - lastY) > 0.01) flushLine();
              lastY = y;
              break;
            }
            case 'T*':
              flushLine();
              break;
            case 'Tj':
            case "'":
            case '"': {
              const raw = [...pending].reverse().find((item) => typeof item === 'string');
              if (operator !== 'Tj') flushLine();
              if (typeof raw === 'string') line += decodeShow(raw);
              break;
            }
            case 'TJ': {
              const array = pending.find((item) => Array.isArray(item)) as unknown[] | undefined;
              if (Array.isArray(array)) {
                for (const item of array) {
                  if (typeof item === 'string') line += decodeShow(item);
                  else if (typeof item === 'number' && item < -180) line += ' ';
                }
              }
              break;
            }
            default:
              break;
          }
          pending = [];
          continue;
        }
        pending.push(token.value as string | number);
      }
      flushLine();
    } else {
      errors.push('页面对象缺失');
    }

    pages.push({
      index: pageIndex + 1,
      objectNumber: pageObjectNumber,
      text,
      chars: text.replace(/\s/g, '').length,
      hasTextLayer: text.replace(/\s/g, '').length > 0,
      errors,
      width,
      height,
    });
  });

  const images: PdfImageInfo[] = [];
  for (const [number, object] of objects) {
    if (!/\/Subtype\s*\/Image/.test(object.dict)) continue;
    images.push({
      objectNumber: number,
      width: Number.parseInt(/\/Width\s+(\d+)/.exec(object.dict)?.[1] ?? '0', 10) || null,
      height: Number.parseInt(/\/Height\s+(\d+)/.exec(object.dict)?.[1] ?? '0', 10) || null,
      filter: /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(object.dict)?.[1] ?? null,
      bitsPerComponent: Number.parseInt(/\/BitsPerComponent\s+(\d+)/.exec(object.dict)?.[1] ?? '0', 10) || null,
      colorSpace: /\/ColorSpace\s*(\/\w+)/.exec(object.dict)?.[1] ?? null,
    });
  }

  return { version, pageCount: pages.length, pages, images, fonts, notes };
}
