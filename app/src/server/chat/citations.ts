/**
 * 引用校验与出处链接生成（阶段 4 任务书第 3.3、3.4 节）
 *
 * 铁律：
 *   - 只有**本次服务端选中的**编号（S1..Sn）才能成为引用；
 *   - 模型输出里的未知编号（如 S99）、磁盘路径、任意 URL 一律丢弃并记录，绝不生成可点击出处；
 *   - 链接由服务端生成（内部 API 路径 + 服务端保存的 source_id/locator），模型无法注入。
 */

export interface SelectableEvidence {
  sid: string;
  sourceId: string | null;
  pagePath: string;
  locatorType: string;
  locatorValue: string | null;
  qualityStatus: string;
  citable: boolean;
}

export interface ValidatedCitation {
  sid: string;
  sourceId: string;
  pagePath: string;
  locatorType: string;
  locatorValue: string | null;
  qualityStatus: 'usable' | 'needs_review';
  /** 服务端生成的内部链接（不来自模型文本） */
  href: string;
  /** 展示用标签，例如「来源 src-08862b06aea9 ¶0002」 */
  label: string;
  needsQualityNotice: boolean;
}

export interface CitationValidationResult {
  citations: ValidatedCitation[];
  /** 模型提到但未被本次选页清单映射的编号（按出现顺序、去重） */
  unmappedSids: string[];
  /** 模型文本里出现的可疑外部路径/URL（仅供审计，永不渲染为链接） */
  rejectedExternalRefs: string[];
  /** 文本中出现的全部 Sx 编号（供审计） */
  mentionedSids: string[];
}

const SID_PATTERN = /\bS(\d{1,3})\b/g;
const PATH_PATTERN = /(?:[A-Za-z]:\\[^\s)"'<]+|(?:\.\.\/)+[^\s)"'<]+)/g;
const URL_PATTERN = /https?:\/\/[^\s)"'<]+/g;

/** 生成服务端内部出处链接；定位信息来自快照而非模型文本。 */
export function buildSourceHref(sourceId: string, locatorType: string, locatorValue: string | null): string {
  const base = `/api/sources/${encodeURIComponent(sourceId)}`;
  if (locatorValue === null || locatorType === 'none') return base;
  return `${base}?locator=${encodeURIComponent(locatorValue)}`;
}

export function validateCitations(modelText: string, evidence: SelectableEvidence[]): CitationValidationResult {
  const mentionedSids = [...new Set([...String(modelText ?? '').matchAll(SID_PATTERN)].map((match) => `S${match[1]}`))];
  const allowed = new Map(
    evidence
      .filter((item) => item.citable && item.sourceId !== null && item.locatorType !== 'none')
      .map((item) => [item.sid, item]),
  );

  const citations: ValidatedCitation[] = [];
  const unmappedSids: string[] = [];
  for (const sid of mentionedSids) {
    const item = allowed.get(sid);
    if (!item) {
      unmappedSids.push(sid);
      continue;
    }
    citations.push({
      sid: item.sid,
      sourceId: item.sourceId!,
      pagePath: item.pagePath,
      locatorType: item.locatorType,
      locatorValue: item.locatorValue,
      qualityStatus: item.qualityStatus === 'needs_review' ? 'needs_review' : 'usable',
      href: buildSourceHref(item.sourceId!, item.locatorType, item.locatorValue),
      label: `来源 ${item.sourceId} ${item.locatorValue ?? ''}`.trim(),
      needsQualityNotice: item.qualityStatus === 'needs_review',
    });
  }

  const rejectedExternalRefs = [
    ...new Set([
      ...[...String(modelText ?? '').matchAll(PATH_PATTERN)].map((match) => match[0]),
      ...[...String(modelText ?? '').matchAll(URL_PATTERN)].map((match) => match[0]),
    ]),
  ];

  return { citations, unmappedSids, rejectedExternalRefs, mentionedSids };
}

/**
 * 把模型文本里**未被映射**的 Sx 编号标注掉（不删除内容，避免改变模型原意，
 * 但确保它们不会在渲染层变成可点击出处）。展示层以服务端保存的 citations 为准。
 */
export function annotateUnmappedSids(modelText: string, unmappedSids: string[]): string {
  if (unmappedSids.length === 0) return modelText;
  let output = String(modelText ?? '');
  for (const sid of unmappedSids) {
    output = output.replace(new RegExp(`\\b${sid}\\b`, 'g'), `${sid}（未映射，不作为出处）`);
  }
  return output;
}
