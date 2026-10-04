// 历法决策的补充边界检查（阶段 3，开发期工具）
import { Solar } from 'lunar-typescript';
import solarlunar from 'solarlunar';

console.log('=== 1) solarlunar 在 1899/1900 的返回值（判断是范围差异还是口径分歧）===');
for (const [y, m, d] of [[1899, 12, 31], [1900, 1, 1], [1900, 2, 1], [1901, 1, 1], [1900, 1, 31]]) {
  const r = solarlunar.solar2lunar(y, m, d);
  console.log(`  ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} -> ${r === null || r === undefined ? 'null/undefined（超出支持范围）' : 'gzDay=' + r.gzDay}`);
}
const wide = Solar.fromYmd(1899, 12, 31).getLunar();
console.log(`  主实现 lunar-typescript 同日期：日柱=${wide.getDayInGanZhi()}（有结果）`);
console.log(`  再试主实现更早/更晚：1800-01-01 -> ${Solar.fromYmd(1800, 1, 1).getLunar().getDayInGanZhi()}；2200-12-31 -> ${Solar.fromYmd(2200, 12, 31).getLunar().getDayInGanZhi()}`);

console.log('\n=== 2) 节气交接瞬间：月柱用「按天」还是「按交接时刻」 ===');
// 先求 2026 立秋的精确时刻
const jieqi = Solar.fromYmd(2026, 8, 7).getLunar().getJieQiTable();
const liqiu = jieqi['立秋'];
console.log(`  2026 立秋交接时刻（库给出）：${liqiu.toYmdHms()}`);
const around = [
  [2026, 8, 6, 23, 30], [2026, 8, 7, 0, 30], [2026, 8, 7, 12, 0],
  [liqiu.getYear(), liqiu.getMonth(), liqiu.getDay(), liqiu.getHour(), liqiu.getMinute()],
];
for (const [y, m, d, h, mi] of around) {
  const l = Solar.fromYmdHms(y, m, d, h, mi, 0).getLunar();
  console.log(
    `  ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` +
      ` 月柱(按天)=${l.getMonthInGanZhi()} 月柱(按节气时刻)=${l.getMonthInGanZhiExact()}`,
  );
}

console.log('\n=== 3) Node 自身时区能力（生产路径不依赖 Python）===');
for (const zone of ['Asia/Shanghai', 'Asia/Urumqi', 'America/New_York', 'Not/AZone']) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    console.log(`  ${zone} -> ${fmt.format(new Date('2026-08-04T03:17:00Z'))}`);
  } catch (error) {
    console.log(`  ${zone} -> 抛错：${error.constructor.name}`);
  }
}
console.log(`  Node 版本 ${process.version}；ICU 数据 ${process.config.variables.icu_small ? 'small' : 'full'}`);
