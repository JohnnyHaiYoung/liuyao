/**
 * 确定性排盘核心（阶段 3）
 *
 * 边界：只输出可核对的排盘事实（卦、宫、世应、纳甲、六亲、六神、伏神、旬空、动变），
 * 不调用 LLM、不读聊天历史、不访问网络、不给出任何吉凶推断。
 * 相同规范化输入 + 相同历法 + 相同规则版本 → 相同盘面；audit 字段不参与等价比较。
 */
import {
  BRANCH_ELEMENT,
  CONTROLS,
  GENERATES,
  PALACE_PATTERNS,
  SIX_SPIRITS,
  TRIGRAMS,
  hexagramOf,
  sixRelative,
  spiritStartIndex,
  voidBranches,
  type TrigramInfo,
} from './rules.ts';
import { PaipanError, type CalendarContext } from './calendar.ts';

export const SCHEMA_VERSION = 'liuyao-chart.v1';
export const CORE_VERSION = 'paipan-core/0.1.0';

export interface BuildOptions {
  questionCategory?: string;
  /** 原始爻值字符串（调用方传入，原样回显以便追溯；见验收报告 P1-1） */
  rawLineValues?: string[];
  /** 审计元数据；不参与盘面等价比较 */
  generatedAt?: string;
}

export interface ChartLine {
  position: number;
  value: number;
  yinYang: 'yang' | 'yin';
  moving: boolean;
  marker: '' | '○' | '×';
  najia: { stem: string; branch: string; element: string } | null;
  sixRelative: string | null;
  sixSpirit: string | null;
  isShi: boolean;
  isYing: boolean;
  isVoid: boolean | null;
  changed: { yinYang: 'yang' | 'yin'; najia: { stem: string; branch: string; element: string }; sixRelative: string } | null;
}

export interface UnavailableField {
  field: string;
  reason: string;
}

export interface ChartResult {
  schemaVersion: string;
  ruleProfileVersion: string;
  coreVersion: string;
  input: {
    lineValues: number[];
    /** 调用方传入的原始爻值字符串（原样回显，便于追溯；阶段 3 复验 P1-1 要求） */
    rawLineValues: string[];
    order: 'bottom_up';
    orderNote: string;
    movingPositions: number[];
  };
  calendar: (CalendarContext & { voidBranches?: [string, string] | null }) | null;
  chart: {
    original: { name: string; code: string; upperTrigram: string; lowerTrigram: string };
    changed: { name: string; code: string; upperTrigram: string; lowerTrigram: string } | null;
    palace: { name: string; element: string; stage: string };
    shiPosition: number;
    yingPosition: number;
    voidBranches: [string, string] | null;
  };
  lines: ChartLine[];
  hiddenLines: Array<{
    sixRelative: string;
    position: number;
    najia: { stem: string; branch: string; element: string };
    flying: { najia: { stem: string; branch: string; element: string }; sixRelative: string };
  }>;
  unavailable: UnavailableField[];
  audit: { generatedAt: string; note: string };
}

const splitGanzhi = (ganzhi: string): { stem: string; branch: string; element: string } => ({
  stem: ganzhi.slice(0, 1),
  branch: ganzhi.slice(1, 2),
  element: BRANCH_ELEMENT[ganzhi.slice(1, 2)] ?? '未知',
});

function palaceOf(bits: number[]): { trigram: TrigramInfo; stage: string; shi: number } {
  for (const trigram of TRIGRAMS) {
    const pure = [...trigram.bits, ...trigram.bits];
    const mask = bits.map((bit, index) => (bit === pure[index] ? '0' : '1')).join('');
    const pattern = PALACE_PATTERNS.find((item) => item.mask === mask);
    if (pattern) return { trigram, stage: pattern.stage, shi: pattern.shi };
  }
  throw new PaipanError('palace_not_found', `无法判定卦宫：${bits.join('')}`);
}

/** 某卦六爻的纳甲（下卦管初二三、上卦管四五六）。 */
function najiaOf(bits: number[]): Array<{ stem: string; branch: string; element: string }> {
  const { upper, lower } = hexagramOf(bits);
  return [
    ...lower.inner.map(splitGanzhi),
    ...upper.outer.map(splitGanzhi),
  ];
}

export function buildChart(lineValues: number[], calendar: CalendarContext | null, options: BuildOptions = {}): ChartResult {
  if (!Array.isArray(lineValues) || lineValues.length !== 6) {
    throw new PaipanError('invalid_line_value', `需要恰好 6 个爻值（初爻在前），收到 ${Array.isArray(lineValues) ? lineValues.length : 0} 个`);
  }
  for (const [index, value] of lineValues.entries()) {
    if (![6, 7, 8, 9].includes(value)) {
      throw new PaipanError('invalid_line_value', `第 ${index + 1} 个爻值必须是 6/7/8/9 之一（初爻在前），收到 ${value}`);
    }
  }

  const bits = lineValues.map((value) => (value === 7 || value === 9 ? 1 : 0));
  const movingPositions = lineValues.map((value, index) => (value === 6 || value === 9 ? index + 1 : 0)).filter((value) => value > 0);
  const original = hexagramOf(bits);
  const changedBits = bits.map((bit, index) => (lineValues[index] === 6 || lineValues[index] === 9 ? 1 - bit : bit));
  const changed = movingPositions.length > 0 ? hexagramOf(changedBits) : null;
  const palace = palaceOf(bits);
  const yingPosition = ((palace.shi + 2) % 6) + 1;

  const unavailable: UnavailableField[] = [];
  const dayGanzhi = calendar?.dayGanzhi ?? null;
  if (!calendar) {
    unavailable.push(
      { field: 'calendar', reason: '未提供起卦时刻或已知日柱/月建；本模块不猜填历法字段' },
      { field: 'lines[].sixSpirit', reason: '六神按日干起例，缺日柱' },
      { field: 'lines[].isVoid', reason: '旬空按日柱定旬，缺日柱' },
      { field: 'chart.voidBranches', reason: '旬空按日柱定旬，缺日柱' },
      { field: 'chart.monthBranch', reason: '缺月建' },
    );
  }

  const originalNajia = najiaOf(bits);
  const changedNajia = najiaOf(changedBits);
  const spiritStart = dayGanzhi ? spiritStartIndex(dayGanzhi.slice(0, 1)) : null;
  const voidPair = dayGanzhi ? voidBranches(dayGanzhi) : null;

  const lines: ChartLine[] = lineValues.map((value, index) => {
    const position = index + 1;
    const najia = originalNajia[index]!;
    const relative = sixRelative(palace.trigram.element, najia.element);
    const moving = value === 6 || value === 9;
    const isVoidBranch = voidPair ? voidPair.includes(najia.branch) : null;
    return {
      position,
      value,
      yinYang: bits[index] === 1 ? 'yang' : 'yin',
      moving,
      marker: value === 9 ? '○' : value === 6 ? '×' : '',
      najia,
      sixRelative: relative,
      sixSpirit: spiritStart === null ? null : SIX_SPIRITS[(spiritStart + index) % 6]!,
      isShi: position === palace.shi,
      isYing: position === yingPosition,
      isVoid: isVoidBranch,
      changed: moving
        ? {
            yinYang: changedBits[index] === 1 ? 'yang' : 'yin',
            najia: changedNajia[index]!,
            sixRelative: sixRelative(palace.trigram.element, changedNajia[index]!.element),
          }
        : null,
    };
  });

  // 伏神：本卦六亲不现者，从本宫纯卦中取该六亲所临之爻
  const present = new Set(lines.map((line) => line.sixRelative));
  const pureBits = [...palace.trigram.bits, ...palace.trigram.bits];
  const pureNajia = najiaOf(pureBits);
  const hiddenLines: ChartResult['hiddenLines'] = [];
  for (const relative of ['父母', '兄弟', '子孙', '妻财', '官鬼']) {
    if (present.has(relative)) continue;
    for (let index = 0; index < 6; index += 1) {
      const pureRelative = sixRelative(palace.trigram.element, pureNajia[index]!.element);
      if (pureRelative !== relative) continue;
      const flying = lines[index]!;
      hiddenLines.push({
        sixRelative: relative,
        position: index + 1,
        najia: pureNajia[index]!,
        flying: { najia: flying.najia!, sixRelative: flying.sixRelative! },
      });
    }
  }
  if (hiddenLines.length > 0 && !calendar) {
    // 伏神不依赖日柱，可照常给出；此处仅说明强度类派生字段未计算
    unavailable.push({ field: 'hiddenLines[].strength', reason: '缺少日月，未计算伏神旺衰（本阶段不输出该类派生字段）' });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    ruleProfileVersion: 'liuyao-rule-profile.v1',
    coreVersion: CORE_VERSION,
    input: {
      lineValues: [...lineValues],
      rawLineValues: options.rawLineValues ?? lineValues.map((value) => String(value)),
      order: 'bottom_up',
      orderNote: '索引 0 = 初爻；显示可自上而下，但原始输入与计算不得倒序',
      movingPositions,
    },
    calendar: calendar ? { ...calendar, voidBranches: voidPair } : null,
    chart: {
      original: { name: original.name, code: original.code, upperTrigram: original.upper.name, lowerTrigram: original.lower.name },
      changed: changed ? { name: changed.name, code: changed.code, upperTrigram: changed.upper.name, lowerTrigram: changed.lower.name } : null,
      palace: { name: palace.trigram.name, element: palace.trigram.element, stage: palace.stage },
      shiPosition: palace.shi,
      yingPosition,
      voidBranches: voidPair,
    },
    lines,
    hiddenLines,
    unavailable,
    audit: {
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      note: '审计元数据不参与盘面等价比较（等价比较请使用 --canonical）',
    },
  };
}

/** 去掉审计元数据后的规范化结果，用于稳定性比较。 */
export function canonicalize(result: ChartResult): Omit<ChartResult, 'audit'> {
  const { audit, ...rest } = result;
  void audit;
  return rest;
}

export { CONTROLS, GENERATES };
