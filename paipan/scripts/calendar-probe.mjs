// 历法候选核对探针（阶段 3，开发期工具）
//
// 证据等级说明：
//   [原页] 期望值来自阶段 2 包内原书原页印刷的「公历/农历 ↔ 干支」对照，属"原书原页核对"等级；
//   [独立] 由不同作者的第二个实现（solarlunar，ISC）计算，属"独立实现对照"等级；
//   [弱]   主实现 lunar-typescript 与 Python 侧 lunar_python 同作者(6tail)，两者一致只算弱证据。
//
// 运行：node paipan/scripts/calendar-probe.mjs
import { Solar, Lunar } from 'lunar-typescript';
import solarlunar from 'solarlunar';

const results = [];
const record = (name, expected, actual, level, note = '') => {
  const pass = expected === actual;
  results.push({ name, expected, actual, level, note, pass });
};

// ---- 1) [原页] 阶段 2 包内原书印出的对照 ----
// (a) PDF《邵伟华周易预测学(下)》原页：农历 1997 八月初七 记作「癸丑」日
{
  const l = Lunar.fromYmd(1997, 8, 7);
  record('原页锚点 a：农历 1997 八月初七 日柱', '癸丑', l.getDayInGanZhi(), '原页',
    `公历 ${l.getSolar().toYmd()}（原页出处：corpus/figures/src-e6fc8612e955/page-002.md）`);
}
// (b) 旧 DOC《六爻用神答疑》原页：公历 2006-05-10 14:22 → 丙戌年 癸巳月 己亥日 辛未时
{
  const l = Solar.fromYmdHms(2006, 5, 10, 14, 22, 0).getLunar();
  record('原页锚点 b：2006-05-10 14:22 年柱', '丙戌', l.getYearInGanZhi(), '原页');
  record('原页锚点 b：2006-05-10 14:22 月柱', '癸巳', l.getMonthInGanZhi(), '原页');
  record('原页锚点 b：2006-05-10 14:22 日柱', '己亥', l.getDayInGanZhi(), '原页');
  record('原页锚点 b：2006-05-10 14:22 时柱', '辛未', l.getTimeInGanZhi(), '原页',
    `农历 ${l.getMonthInChinese()}月${l.getDayInChinese()}（原页出处：corpus/cleaned/src-3f8243c07930.md）`);
}
// (c) 扫描件《张成达-六爻快速断卦法》原页：2003-12-25 9 点多 → 癸未 甲子 壬申 乙巳
{
  const l = Solar.fromYmdHms(2003, 12, 25, 9, 30, 0).getLunar();
  record('原页锚点 c：2003-12-25 09:30 年柱', '癸未', l.getYearInGanZhi(), '原页');
  record('原页锚点 c：2003-12-25 09:30 月柱', '甲子', l.getMonthInGanZhi(), '原页');
  record('原页锚点 c：2003-12-25 09:30 日柱', '壬申', l.getDayInGanZhi(), '原页');
  record('原页锚点 c：2003-12-25 09:30 时柱', '乙巳', l.getTimeInGanZhi(), '原页',
    '原页出处：corpus/figures/src-f3f838d501b1/page-002.md');
}

// ---- 2) [独立] 不同作者实现的对照（日柱与农历换算）----
const independentCases = [
  ['1899-12-31', 1899, 12, 31],
  ['1900-01-01', 1900, 1, 1],
  ['1997-07-09', 1997, 7, 9],
  ['1997-09-08', 1997, 9, 8],
  ['2000-02-29', 2000, 2, 29],
  ['2006-05-10', 2006, 5, 10],
  ['2024-02-29', 2024, 2, 29],
  ['2026-08-04', 2026, 8, 4],
  ['2033-11-05', 2033, 11, 5],
];
let independentSame = 0;
for (const [label, y, m, d] of independentCases) {
  const mine = Solar.fromYmd(y, m, d).getLunar();
  const mineDay = mine.getDayInGanZhi();
  const other = solarlunar.solar2lunar(y, m, d);
  const otherDay = other && other.gzDay;
  const same = mineDay === otherDay;
  if (same) independentSame += 1;
  record(`独立对照 ${label} 日柱`, otherDay ?? '(无)', mineDay, '独立',
    same ? '两实现一致' : '★两实现不一致，须查明口径');
}
console.log(`\n[独立] 日柱一致 ${independentSame}/${independentCases.length}`);

// ---- 3) 日界与边界 ----
const boundary = (label, y, m, d, h, mi) => {
  const l = Solar.fromYmdHms(y, m, d, h, mi, 0).getLunar();
  return `${label}: 日柱(默认)=${l.getDayInGanZhi()} Exact=${l.getDayInGanZhiExact()} Exact2=${l.getDayInGanZhiExact2()} 时柱=${l.getTimeInGanZhi()}`;
};
console.log('\n--- 日界（23:00 与 00:00）---');
for (const line of [
  boundary('2024-01-01 22:30', 2024, 1, 1, 22, 30),
  boundary('2024-01-01 23:30', 2024, 1, 1, 23, 30),
  boundary('2024-01-02 00:30', 2024, 1, 2, 0, 30),
  boundary('2024-01-02 12:00', 2024, 1, 2, 12, 0),
]) console.log('  ' + line);

console.log('\n--- 节气边界（以 2026 立秋 08-07 为界，取前后各一天）---');
for (const d of [5, 6, 7, 8, 9]) {
  const l = Solar.fromYmd(2026, 8, d).getLunar();
  console.log(`  2026-08-${String(d).padStart(2, '0')} 月柱=${l.getMonthInGanZhi()} 日柱=${l.getDayInGanZhi()} 前一节=${l.getPrevJieQi(true).getName()}`);
}

console.log('\n--- 无效日期与支持范围 ---');
for (const [label, y, m, d] of [['2026-02-30', 2026, 2, 30], ['1899-01-01', 1899, 1, 1], ['2100-12-31', 2100, 12, 31]]) {
  try {
    const l = Solar.fromYmd(y, m, d).getLunar();
    console.log(`  ${label} -> 农历 ${l.getYearInChinese()}-${l.getMonthInChinese()}-${l.getDayInChinese()} 日柱=${l.getDayInGanZhi()}`);
  } catch (error) {
    console.log(`  ${label} -> 抛错：${error.constructor.name}: ${error.message}`);
  }
}

// ---- 4) 汇总 ----
const failed = results.filter((item) => !item.pass);
console.log('\n=== 逐项结果 ===');
for (const item of results) console.log(`  [${item.pass ? '通过' : '不通过'}][${item.level}] ${item.name}：期望 ${item.expected} / 实际 ${item.actual}${item.note ? ' ｜ ' + item.note : ''}`);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length > 0 ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
