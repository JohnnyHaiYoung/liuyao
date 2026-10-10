/**
 * 目录选页与证据片段（阶段 4 任务书第 3.2–3.4 节）
 *
 * 规则：
 *   - 只用标题/主题/别名/显式链接选页，不遍历全部原件、不用 embedding 或向量检索；
 *   - 预算：页数 ≤ maxPages（默认 4）、正文合计 ≤ maxChars（默认 16000），超限如实标注；
 *   - 对模型只给带编号的有限片段；每条片段须能给出 source_id 与 ¶NNNN/页码定位，否则标记不可引用；
 *   - 页面内容与目录登记哈希不一致时拒绝引用（目录过期必须显式暴露，不静默使用）。
 */
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_EXCERPT_CHARS,
  DEFAULT_MAX_PAGES,
  readCatalogPage,
  type CatalogPage,
  type WikiCatalog,
  type WikiRuntimeOptions,
} from './catalog.ts';
import { sourceDataReady } from './coverage.ts';

export interface SelectedPage {
  pageId: string;
  path: string;
  title: string;
  qualityStatus: 'usable' | 'needs_review';
  score: number;
  reason: string;
  hashMatches: boolean;
  sha256: string;
}

export interface EvidenceSnippet {
  sid: string;
  pageId: string;
  pagePath: string;
  title: string;
  sourceId: string | null;
  locatorType: 'paragraph' | 'page' | 'none';
  locatorValue: string | null;
  qualityStatus: 'usable' | 'needs_review';
  excerpt: string;
  pageSha256: string;
  citable: boolean;
  reason: string;
}

export interface SelectResult {
  selectedPages: SelectedPage[];
  snippets: EvidenceSnippet[];
  consideredPageCount: number;
  totalChars: number;
  budgetExceeded: boolean;
  noLocalEvidence: boolean;
  warnings: string[];
}

/** 去掉主题里的编号前缀（「一、」「1.」等），便于与用户问题匹配。 */
function normalizeLabel(label: string): string {
  return label.replace(/^[\s#>*\-]+/, '').replace(/^[0-9一二三四五六七八九十]+[、.．)）]\s*/, '').trim();
}

/** 疑问/填充词，不参与匹配（避免 2 字噪声词把无关页面拉进来）。 */
const STOP_TERMS = new Set(['什么', '怎么', '如何', '为什么', '可以', '是否', '多少', '哪些', '这个', '那个', '一下', '请问', '我们', '你们', '介绍', '解释', '比较', '区别', '关系']);

/** 从问题文本里抽取候选词：中文按 2–8 字滑窗 + 拉丁词。用于与标题/主题/别名匹配，不做语义检索。 */
function queryTerms(question: string): string[] {
  const cleaned = question.replace(/[\s，。？！、；：""''（）()\[\]【】《》,.?!;:]+/g, ' ').trim();
  const terms = new Set<string>();
  for (const chunk of cleaned.split(/\s+/)) {
    if (chunk === '') continue;
    const chars = Array.from(chunk);
    // 2 字词是六爻概念的主要粒度（用神/六爻/纳甲/旬空/世应），必须保留；
    // 疑问填充词由 STOP_TERMS 排除，靠"命中标题/主题/别名"而非自由文本匹配来控噪。
    for (let size = Math.min(8, chars.length); size >= 2; size -= 1) {
      for (let index = 0; index + size <= chars.length; index += 1) {
        const term = chars.slice(index, index + size).join('');
        if (STOP_TERMS.has(term)) continue;
        if (/^[\u4e00-\u9fa5]{2,8}$/.test(term) || /^[A-Za-z][A-Za-z0-9_-]{1,15}$/.test(term)) terms.add(term);
      }
    }
    if (/^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(chunk)) terms.add(chunk.toLowerCase());
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

interface ScoredPage {
  page: CatalogPage;
  score: number;
  reasons: string[];
}

function scorePage(page: CatalogPage, terms: string[], question: string): ScoredPage {
  const reasons: string[] = [];
  let score = 0;
  const title = page.title;
  const aliases = page.aliases;
  const topics = page.topics.map(normalizeLabel).filter((item) => item !== '');

  for (const alias of aliases) {
    if (alias !== '' && question.includes(alias)) {
      score += 100 + alias.length;
      reasons.push(`别名命中「${alias}」`);
    }
  }
  if (title !== '' && question.includes(title)) {
    score += 60 + title.length;
    reasons.push(`标题命中「${title}」`);
  }
  for (const topic of topics) {
    if (topic.length >= 2 && question.includes(topic)) {
      score += 30 + topic.length;
      reasons.push(`主题命中「${topic}」`);
    }
  }
  // 词级匹配：2 字词权重较低、≥3 字词权重较高；只与标题/别名/主题比对，不做全文相似度
  for (const term of terms) {
    const base = term.length >= 3 ? 12 : 6;
    if (title.includes(term)) {
      score += base + term.length;
      reasons.push(`标题词「${term}」`);
    }
    for (const alias of aliases) {
      if (alias.includes(term)) {
        score += base + term.length - 2;
        reasons.push(`别名词「${term}」`);
      }
    }
    for (const topic of topics) {
      if (topic.includes(term)) {
        score += Math.max(4, base - 6 + term.length);
        reasons.push(`主题词「${term}」`);
        break;
      }
    }
  }
  return { page, score, reasons: [...new Set(reasons)] };
}

/** 摘录：优先取含定位标记的行（¶NNNN 或「第 N 页」），其次取含命中词的行。 */
function buildExcerpt(text: string, terms: string[], maxChars: number): { excerpt: string; hit: boolean; lineIndex: number } {
  const lines = text.split(/\r?\n/);
  const focus: { index: number; weight: number }[] = [];
  for (const [index, line] of lines.entries()) {
    let weight = 0;
    if (/¶\d{4}/.test(line)) weight += 10; // 段落锚点行是"主张"所在，优先于目录/元数据行（复验 2f31a08 P1-2）
    if (/第\s*\d+\s*页/.test(line)) weight += 2;
    for (const term of terms.slice(0, 40)) {
      if (term.length >= 2 && line.includes(term)) weight += 1;
    }
    if (weight > 0) focus.push({ index, weight });
  }
  if (focus.length === 0) {
    return { excerpt: lines.slice(0, 12).join('\n').slice(0, maxChars), hit: false, lineIndex: 0 };
  }
  focus.sort((a, b) => b.weight - a.weight || a.index - b.index);
  const picked: number[] = [];
  for (const item of focus) {
    if (picked.length >= 3) break;
    if (picked.some((index) => Math.abs(index - item.index) <= 2)) continue;
    picked.push(item.index);
  }
  picked.sort((a, b) => a - b);
  const chunks: string[] = [];
  for (const index of picked) {
    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length, index + 3);
    chunks.push(lines.slice(start, end).join('\n'));
  }
  const excerpt = chunks.join('\n…\n');
  return { excerpt: excerpt.slice(0, maxChars), hit: true, lineIndex: picked[0]! };
}

/**
 * 归属来源：从摘录所在行**向前回溯**最近的 `src-xxxxxxxxxxxx` 标注。
 * 概念/对照页会引用多个来源，不能一律取 sourceIds[0]（那会把 A 来源的说法记到 B 名下）。
 * 回溯不到标注时：来源页用自己的 ID；其它页面返回 null（该片段不可引用）。
 */
function attributeSourceId(text: string, lineIndex: number, page: CatalogPage): string | null {
  const lines = text.split(/\r?\n/);
  for (let index = Math.min(lineIndex, lines.length - 1); index >= 0; index -= 1) {
    const match = /src-[0-9a-f]{12}/.exec(lines[index] ?? '');
    if (match) return match[0];
  }
  if (page.kind === 'source') return /(src-[0-9a-f]{12})/.exec(page.path)?.[1] ?? null;
  return null;
}

function locatorOf(excerpt: string, page: CatalogPage, sourceId: string | null): { type: 'paragraph' | 'page' | 'none'; value: string | null; sourceId: string | null } {
  const paragraph = /¶(\d{4})/.exec(excerpt);
  if (paragraph) return { type: 'paragraph', value: `¶${paragraph[1]}`, sourceId };
  const pageNumber = /第\s*(\d+)\s*页/.exec(excerpt);
  if (pageNumber) return { type: 'page', value: `第${pageNumber[1]}页`, sourceId };
  return { type: 'none', value: null, sourceId };
}

export function selectWikiEvidence(
  projectRoot: string,
  catalog: WikiCatalog,
  question: string,
  options: WikiRuntimeOptions = { projectRoot },
): SelectResult {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxExcerpt = options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  const terms = queryTerms(question);
  const warnings: string[] = [];

  const scored = catalog.pages
    .map((page) => scorePage(page, terms, question))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path));

  // 由已命中的概念/对照页扩展其**显式登记的被引来源页**（任务书第 3.1 节：必要时打开可定位的来源页）。
  // 只扩展，不做全文检索；每个非来源页最多带 2 个来源页。
  const candidates: ScoredPage[] = [...scored];
  const already = new Set(candidates.map((item) => item.page.pageId));
  for (const item of scored.filter((entry) => entry.page.kind !== 'source').slice(0, 2)) {
    let added = 0;
    for (const sourceId of item.page.sourceIds) {
      if (added >= 2) break;
      const page = catalog.pages.find((entry) => entry.pageId === `source:${sourceId}`);
      if (!page || already.has(page.pageId)) continue;
      already.add(page.pageId);
      added += 1;
      candidates.push({ page, score: Math.max(1, Math.floor(item.score / 4)), reasons: [`由「${item.page.title}」显式链接的来源页扩展`] });
    }
  }

  // 命中来源页时把同一来源的概念/对照页一并向后延伸（"必要时打开其中可定位的来源页"）
  const selected: SelectedPage[] = [];
  let totalChars = 0;
  let budgetExceeded = false;

  for (const item of candidates) {
    if (selected.length >= maxPages) {
      budgetExceeded = true;
      warnings.push(`选页数超过上限 ${maxPages}，已截断（问题可能过宽，建议缩小范围）`);
      break;
    }
    let read: ReturnType<typeof readCatalogPage>;
    try {
      read = readCatalogPage(projectRoot, item.page);
    } catch (error) {
      warnings.push(`页面读取失败：${item.page.path}（${error instanceof Error ? error.message : String(error)}）`);
      continue;
    }
    if (!read.hashMatches) {
      warnings.push(`目录过期：${item.page.path} 的内容与目录登记哈希不一致，本条不作为引用来源`);
    }
    const remaining = maxChars - totalChars;
    if (remaining <= 0) {
      budgetExceeded = true;
      warnings.push(`正文预算 ${maxChars} 字符已用尽，后续页面未纳入`);
      break;
    }
    totalChars += Math.min(read.text.length, remaining);
    selected.push({
      pageId: item.page.pageId,
      path: item.page.path,
      title: item.page.title,
      qualityStatus: item.page.qualityStatus,
      score: item.score,
      reason: item.reasons.join('；') || '词级匹配',
      hashMatches: read.hashMatches,
      sha256: item.page.sha256,
    });
  }

  const snippets: EvidenceSnippet[] = [];
  let sid = 0;
  for (const page of selected) {
    if (!page.hashMatches) continue; // 目录过期页面不产出可引用片段
    const catalogPage = catalog.pages.find((item) => item.pageId === page.pageId)!;
    const { text } = readCatalogPage(projectRoot, catalogPage);
    const { excerpt, hit, lineIndex } = buildExcerpt(text, terms, maxExcerpt);
    const attributed = attributeSourceId(text, lineIndex, catalogPage);
    const locator = locatorOf(excerpt, catalogPage, attributed);
    sid += 1;
    // 复验 P1-2：编号证据除定位外，还要求来源数据链就绪（原件哈希一致 + 清洗文本存在）
    const dataReady = locator.sourceId !== null ? sourceDataReady(projectRoot, locator.sourceId) : { ready: false, reason: '无来源归属' };
    const citable = locator.type !== 'none' && locator.sourceId !== null && hit && dataReady.ready;
    snippets.push({
      sid: `S${sid}`,
      pageId: page.pageId,
      pagePath: page.path,
      title: page.title,
      sourceId: locator.sourceId,
      locatorType: locator.type,
      locatorValue: locator.value,
      qualityStatus: page.qualityStatus,
      excerpt,
      pageSha256: catalogPage.sha256,
      citable,
      reason: citable
        ? locator.type === 'paragraph'
          ? '含 ¶NNNN 段落锚点'
          : '含 PDF 实际页码'
        : locator.sourceId === null
          ? '无法归属到具体 source_id（页内未找到来源标注），不能作为可点击出处'
          : locator.type === 'none'
            ? '未找到 ¶NNNN/页码定位，不能作为可点击出处'
            : !dataReady.ready
              ? `来源数据链未就绪（${dataReady.reason}），不能作为可点击出处`
              : '未命中问题相关行，仅作背景',
    });
    if (!citable) warnings.push(`片段 ${sid}（${page.path}）不可引用：${snippets[snippets.length - 1]!.reason}`);
    if (page.qualityStatus === 'needs_review') {
      warnings.push(`片段 ${sid} 来源质量为 needs_review：引用时必须标注「待核对」并给出原页图入口`);
    }
  }

  if (selected.length === 0) {
    warnings.push('本地 Wiki 无对应依据：不得伪造出处，回答应注明为一般说明或待核对观点');
  }

  return {
    selectedPages: selected,
    snippets,
    consideredPageCount: catalog.pages.length,
    totalChars,
    budgetExceeded,
    noLocalEvidence: selected.length === 0,
    warnings,
  };
}

export { queryTerms, normalizeLabel };
