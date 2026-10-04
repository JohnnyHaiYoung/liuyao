// 自研排盘核心的核对（阶段 3，开发期工具）
// 目的：与阶段 2 原页转写、以及两套上游实现逐字段对账；不经过 PowerShell 管道（避免 BOM 污染）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '..');
const cli = path.join(moduleRoot, 'bin', 'paipan.ts');

const run = (...args) => {
  const result = spawnSync('node', [cli, ...args], { encoding: 'utf8', windowsHide: true });
  const text = (result.stdout ?? '').replace(/^\uFEFF/, '');
  if (result.status !== 0) throw new Error(`CLI 失败（exit ${result.status}）：${(result.stderr ?? '').slice(0, 200)}`);
  return JSON.parse(text);
};

const expectations = {
  '上': '父母丙寅木', '五': '官鬼丙子水', '四': '子孙丙戌土', '三': '兄弟戊午火', '二': '子孙戊辰土', '初': '父母戊寅木',
};
const positionName = { 6: '上', 5: '五', 4: '四', 3: '三', 2: '二', 1: '初' };
const results = [];
const check = (name, expected, actual) => {
  const pass = expected === actual;
  results.push({ name, expected, actual, pass });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}：期望 ${expected} / 实际 ${actual}`);
};

console.log('=== 1) 原页锚点：山水蒙（初爻在前 8 7 8 8 8 7），日柱戊辰、月建申 ===');
const chart = run('--lines', '8', '7', '8', '8', '8', '7', '--day', '戊辰', '--month', '申', '--canonical');
check('卦名', '山水蒙', chart.chart.original.name);
check('卦宫与阶段', '离宫四世', `${chart.chart.palace.name}宫${chart.chart.palace.stage}`);
check('世应', '世4应1', `世${chart.chart.shiPosition}应${chart.chart.yingPosition}`);
check('旬空', '戌亥', (chart.chart.voidBranches ?? []).join(''));
for (const line of chart.lines) {
  const label = positionName[line.position];
  check(`${label}爻 六亲纳甲`, expectations[label], `${line.sixRelative}${line.najia.stem}${line.najia.branch}${line.najia.element}`);
}
check('六神起例（戊日初爻勾陈）', '勾陈', chart.lines[0].sixSpirit);
check('伏神', '妻财己酉金@4（飞神 子孙丙戌土）', chart.hiddenLines.map((h) => `${h.sixRelative}${h.najia.stem}${h.najia.branch}${h.najia.element}@${h.position}（飞神 ${h.flying.sixRelative}${h.flying.najia.stem}${h.flying.najia.branch}${h.flying.najia.element}）`).join('；'));
check('日界标注（手动模式无日界）', 'undefined', String(chart.calendar.dayBoundary));

console.log('\n=== 2) 自动历法模式：原页锚点 b（2006-05-10 14:22 Asia/Shanghai）===');
const auto = run('--lines', '8', '7', '8', '8', '8', '7', '--at', '2006-05-10T14:22:00', '--timezone', 'Asia/Shanghai', '--canonical');
check('日柱', '己亥', auto.calendar.dayGanzhi);
check('月柱', '癸巳', auto.calendar.monthGanzhi);
check('时柱', '辛未', auto.calendar.hourGanzhi);
check('模式', 'auto_calendar', auto.calendar.mode);
check('历法库记录', 'lunar-typescript@1.8.6', auto.calendar.library);

console.log('\n=== 3) 自动历法模式的日界差异（2024-01-01 23:30）===');
const zi23 = run('--lines', '8', '7', '8', '8', '8', '7', '--at', '2024-01-01T23:30:00', '--timezone', 'Asia/Shanghai', '--day-boundary', 'zi23', '--canonical');
const midnight = run('--lines', '8', '7', '8', '8', '8', '7', '--at', '2024-01-01T23:30:00', '--timezone', 'Asia/Shanghai', '--day-boundary', 'midnight', '--canonical');
check('zi23 日柱', '乙丑', zi23.calendar.dayGanzhi);
check('midnight 日柱', '甲子', midnight.calendar.dayGanzhi);
check('两口径不同', 'true', String(zi23.calendar.dayGanzhi !== midnight.calendar.dayGanzhi));

console.log('\n=== 4) 缺历法时降级（不给 --at / --day / --month）===');
const bare = run('--lines', '8', '7', '8', '8', '8', '7', '--canonical');
check('calendar 为 null', 'null', String(bare.calendar));
check('六神为 null', 'null', String(bare.lines[0].sixSpirit));
check('旬空为 null', 'null', String(bare.chart.voidBranches));
check('缺项原因已记录', 'true', String(bare.unavailable.length >= 4));
check('卦与纳甲仍可算', '山水蒙', bare.chart.original.name);

console.log('\n=== 5) 稳定性（同输入两次 → canonical 完全相同）===');
const a = JSON.stringify(run('--lines', '6', '7', '8', '9', '7', '8', '--day', '庚戌', '--month', '未', '--canonical'));
const b = JSON.stringify(run('--lines', '6', '7', '8', '9', '7', '8', '--day', '庚戌', '--month', '未', '--canonical'));
check('两次输出一致', 'true', String(a === b));

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
