/**
 * 规则与静态数据（阶段 3 排盘核心）
 *
 * 数据来源与证据等级见 paipan/rules/rule-profile.v1.json：
 *   - 纳甲表、六亲/六神/旬空/伏神规则 = domain_rule（由两套上游实现一致印证，见 paipan/scripts/upstream-compare.mjs）
 *   - 64 卦名（上卦×下卦表）与八卦位 = 通行卦名，已用阶段 2 原页转写的 30 余个卦名逐一核对
 *   - 八宫/世应 = 京房八宫 XOR 模式，已用"山水蒙=离宫四世、天火同人=离宫归魂"等原页证据校验
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const moduleRoot = path.resolve(here, '..');
export const projectRoot = path.resolve(moduleRoot, '..');

export interface RuleProfile {
  ruleProfileVersion: string;
  calendar: Record<string, unknown>;
  facts: Record<string, unknown>;
}

export function loadRuleProfile(): RuleProfile {
  return JSON.parse(fs.readFileSync(path.join(moduleRoot, 'rules', 'rule-profile.v1.json'), 'utf8')) as RuleProfile;
}

/** 三爻位（自下而上）。1 = 阳。 */
export type TrigramBits = [number, number, number];

export interface TrigramInfo {
  name: string;
  bits: TrigramBits;
  element: '金' | '木' | '水' | '火' | '土';
  /** 内卦（初二三）干支 */
  inner: [string, string, string];
  /** 外卦（四五六）干支 */
  outer: [string, string, string];
}

/** 八卦：三爻自下而上、五行、纳甲（京房）。与 rule-profile.v1.json 的纳甲表一致。 */
export const TRIGRAMS: TrigramInfo[] = [
  { name: '乾', bits: [1, 1, 1], element: '金', inner: ['甲子', '甲寅', '甲辰'], outer: ['壬午', '壬申', '壬戌'] },
  { name: '兑', bits: [1, 1, 0], element: '金', inner: ['丁巳', '丁卯', '丁丑'], outer: ['丁亥', '丁酉', '丁未'] },
  { name: '离', bits: [1, 0, 1], element: '火', inner: ['己卯', '己丑', '己亥'], outer: ['己酉', '己未', '己巳'] },
  { name: '震', bits: [1, 0, 0], element: '木', inner: ['庚子', '庚寅', '庚辰'], outer: ['庚午', '庚申', '庚戌'] },
  { name: '巽', bits: [0, 1, 1], element: '木', inner: ['辛丑', '辛亥', '辛酉'], outer: ['辛未', '辛巳', '辛卯'] },
  { name: '坎', bits: [0, 1, 0], element: '水', inner: ['戊寅', '戊辰', '戊午'], outer: ['戊申', '戊戌', '戊子'] },
  { name: '艮', bits: [0, 0, 1], element: '土', inner: ['丙辰', '丙午', '丙申'], outer: ['丙戌', '丙子', '丙寅'] },
  { name: '坤', bits: [0, 0, 0], element: '土', inner: ['乙未', '乙巳', '乙卯'], outer: ['癸丑', '癸亥', '癸酉'] },
];

export const TRIGRAM_BY_NAME = new Map(TRIGRAMS.map((item) => [item.name, item]));

/** 上卦（行）× 下卦（列）→ 卦名。行/列顺序：乾 兑 离 震 巽 坎 艮 坤 */
const UPPER_ORDER = ['乾', '兑', '离', '震', '巽', '坎', '艮', '坤'];
const NAME_TABLE: string[][] = [
  ['乾为天', '天泽履', '天火同人', '天雷无妄', '天风姤', '天水讼', '天山遁', '天地否'],
  ['泽天夬', '兑为泽', '泽火革', '泽雷随', '泽风大过', '泽水困', '泽山咸', '泽地萃'],
  ['火天大有', '火泽睽', '离为火', '火雷噬嗑', '火风鼎', '火水未济', '火山旅', '火地晋'],
  ['雷天大壮', '雷泽归妹', '雷火丰', '震为雷', '雷风恒', '雷水解', '雷山小过', '雷地豫'],
  ['风天小畜', '风泽中孚', '风火家人', '风雷益', '巽为风', '风水涣', '风山渐', '风地观'],
  ['水天需', '水泽节', '水火既济', '水雷屯', '水风井', '坎为水', '水山蹇', '水地比'],
  ['山天大畜', '山泽损', '山火贲', '山雷颐', '山风蛊', '山水蒙', '艮为山', '山地剥'],
  ['地天泰', '地泽临', '地火明夷', '地雷复', '地风升', '地水师', '地山谦', '坤为地'],
];

/** 由六爻位（自下而上，1=阳）取上下卦与卦名。 */
export function hexagramOf(bits: number[]): { name: string; upper: TrigramInfo; lower: TrigramInfo; code: string } {
  const lower = TRIGRAMS.find((item) => item.bits.every((bit, index) => bit === bits[index]))!;
  const upper = TRIGRAMS.find((item) => item.bits.every((bit, index) => bit === bits[index + 3]))!;
  // 表中行 = 上卦、列 = 下卦（如行「乾」为乾为天/天泽履/…）——索引顺序不可颠倒。
  const name = NAME_TABLE[UPPER_ORDER.indexOf(upper.name)]![UPPER_ORDER.indexOf(lower.name)]!;
  return { name, upper, lower, code: bits.join('') };
}

/** 京房八宫：以本卦与八纯卦异或匹配世位模式（自下而上，1=该位不同）。 */
export const PALACE_PATTERNS: Array<{ mask: string; stage: string; shi: number }> = [
  { mask: '000000', stage: '本宫', shi: 6 },
  { mask: '100000', stage: '一世', shi: 1 },
  { mask: '110000', stage: '二世', shi: 2 },
  { mask: '111000', stage: '三世', shi: 3 },
  { mask: '111100', stage: '四世', shi: 4 },
  { mask: '111110', stage: '五世', shi: 5 },
  { mask: '111010', stage: '游魂', shi: 4 },
  { mask: '000010', stage: '归魂', shi: 3 },
];

export const BRANCH_ELEMENT: Record<string, string> = {
  子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火',
  午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水',
};

export const GENERATES: Record<string, string> = { 金: '水', 水: '木', 木: '火', 火: '土', 土: '金' };
export const CONTROLS: Record<string, string> = { 金: '木', 木: '土', 土: '水', 水: '火', 火: '金' };

/** 六亲：以卦宫五行为「我」。 */
export function sixRelative(palaceElement: string, branchElement: string): string {
  if (palaceElement === branchElement) return '兄弟';
  if (GENERATES[branchElement] === palaceElement) return '父母';
  if (GENERATES[palaceElement] === branchElement) return '子孙';
  if (CONTROLS[branchElement] === palaceElement) return '官鬼';
  if (CONTROLS[palaceElement] === branchElement) return '妻财';
  return '未知';
}

export const SIX_SPIRITS = ['青龙', '朱雀', '勾陈', '螣蛇', '白虎', '玄武'];
export const STEM_INDEX: Record<string, number> = { 甲: 0, 乙: 1, 丙: 2, 丁: 3, 戊: 4, 己: 5, 庚: 6, 辛: 7, 壬: 8, 癸: 9 };
export const BRANCH_INDEX: Record<string, number> = {
  子: 0, 丑: 1, 寅: 2, 卯: 3, 辰: 4, 巳: 5, 午: 6, 未: 7, 申: 8, 酉: 9, 戌: 10, 亥: 11,
};

/** 日干起六神：甲乙青龙、丙丁朱雀、戊勾陈、己螣蛇、庚辛白虎、壬癸玄武。 */
export function spiritStartIndex(dayStem: string): number {
  const index = STEM_INDEX[dayStem];
  if (index === undefined) return 0;
  return [0, 0, 1, 1, 2, 3, 4, 4, 5, 5][index]!;
}

/** 旬空：由日柱干支定旬，返回该旬所缺两支。 */
export function voidBranches(dayGanzhi: string): [string, string] | null {
  if (dayGanzhi.length !== 2) return null;
  const stem = STEM_INDEX[dayGanzhi[0]!];
  const branch = BRANCH_INDEX[dayGanzhi[1]!];
  if (stem === undefined || branch === undefined) return null;
  const xunStart = (branch - stem + 12) % 12;
  const names = Object.keys(BRANCH_INDEX);
  return [names[(xunStart + 10) % 12]!, names[(xunStart + 11) % 12]!];
}
