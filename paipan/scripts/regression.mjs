// 验收报告（7a6ab8d）四项 P1 的反例回归（阶段 3）
// 复验命令：node paipan/scripts/regression.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSexagenary, sexagenaryCycle } from '../src/calendar.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'bin', 'paipan.ts');

const run = (...args) => {
  const result = spawnSync('node', [cli, ...args], { encoding: 'utf8', windowsHide: true });
  const stdout = (result.stdout ?? '').replace(/^\uFEFF/, '');
  const stderr = (result.stderr ?? '').replace(/^\uFEFF/, '');
  let json = null;
  try {
    json = JSON.parse(stdout || stderr);
  } catch {
    json = null;
  }
  return { status: result.status, json, stdout, stderr };
};

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};

console.log('=== P1-1 命令行非法/不完整输入 ===');
for (const [label, args, code] of [
  ['爻值 7abc', ['--lines', '7abc', '7', '7', '7', '7', '7', '--day', '甲子', '--month', '寅', '--canonical'], 'invalid_line_value'],
  ['爻值 7.5', ['--lines', '7.5', '7', '7', '7', '7', '7', '--day', '甲子', '--month', '寅', '--canonical'], 'invalid_line_value'],
  ['爻值个数不足', ['--lines', '7', '7', '7', '--day', '甲子', '--month', '寅'], 'invalid_line_value'],
  ['--at 缺值', ['--lines', '7', '7', '7', '7', '7', '7', '--at', '--timezone', 'Asia/Shanghai', '--canonical'], 'missing_option_value'],
  ['--timezone 缺值', ['--lines', '7', '7', '7', '7', '7', '7', '--at', '2024-02-08T12:00:00', '--timezone'], 'missing_option_value'],
  ['未知参数', ['--lines', '7', '7', '7', '7', '7', '7', '--day', '甲子', '--month', '寅', '--bogus'], 'unknown_option'],
  ['重复 --at', ['--lines', '7', '7', '7', '7', '7', '7', '--at', '2024-02-08T12:00:00', '--at', '2024-02-09T12:00:00', '--timezone', 'Asia/Shanghai'], 'duplicate_option'],
]) {
  const result = run(...args);
  check(label, result.status === 2 && result.json?.error?.code === code, `exit=${result.status} code=${result.json?.error?.code ?? '(无)'}`);
}

console.log('\n=== P1-1 模式冲突与输入来源回显 ===');
{
  const conflict = run('--lines', '7', '7', '7', '7', '7', '7', '--at', '2024-02-08T12:00:00', '--timezone', 'Asia/Shanghai', '--day', '甲子', '--month', '寅', '--canonical');
  check('--at 与 --day/--month 冲突', conflict.status === 2 && conflict.json?.error?.code === 'conflicting_calendar_mode', `exit=${conflict.status} code=${conflict.json?.error?.code ?? '(无)'}`);
  const timezoneAlone = run('--lines', '7', '7', '7', '7', '7', '7', '--day', '甲子', '--month', '寅', '--timezone', 'Asia/Shanghai', '--canonical');
  check('手动模式带 --timezone 被拒', timezoneAlone.status === 2 && timezoneAlone.json?.error?.code === 'conflicting_calendar_mode', `code=${timezoneAlone.json?.error?.code ?? '(无)'}`);
  const ok = run('--lines', '7', '7', '9', '6', '6', '7', '--day', '戊戌', '--month', '亥', '--canonical');
  check('合法输入回显原始爻值字符串', ok.status === 0 && JSON.stringify(ok.json?.input?.rawLineValues) === JSON.stringify(['7', '7', '9', '6', '6', '7']), `rawLineValues=${JSON.stringify(ok.json?.input?.rawLineValues)}`);
  check('合法输入回显历法来源', ok.status === 0 && typeof ok.json?.calendar?.source === 'string' && ok.json.calendar.source.includes('--day'), `source=${ok.json?.calendar?.source ?? '(无)'}`);
}

console.log('\n=== P1-2 六十甲子合法性 ===');
{
  check('甲丑 非法（阳干配阴支）', isSexagenary('甲丑') === false, `isSexagenary('甲丑')=${isSexagenary('甲丑')}`);
  check('乙子 非法', isSexagenary('乙子') === false, `isSexagenary('乙子')=${isSexagenary('乙子')}`);
  check('戊辰 合法', isSexagenary('戊辰') === true, `isSexagenary('戊辰')=${isSexagenary('戊辰')}`);
  check('六十甲子恰 60 个且互不重复', new Set(sexagenaryCycle()).size === 60 && sexagenaryCycle().length === 60, `size=${new Set(sexagenaryCycle()).size}`);
  const bad = run('--lines', '7', '7', '7', '7', '7', '7', '--day', '甲丑', '--month', '寅', '--canonical');
  check('--day 甲丑 被拒且不产生盘面', bad.status === 2 && bad.json?.error?.code === 'invalid_day_ganzhi' && !bad.stdout.includes('voidBranches'), `exit=${bad.status} code=${bad.json?.error?.code ?? '(无)'}`);
}

console.log('\n=== P1-3 节气窗口按交接时刻 ===');
{
  const before = run('--lines', '7', '7', '7', '7', '7', '7', '--at', '2026-08-07T19:42:42', '--timezone', 'Asia/Shanghai', '--canonical');
  const at = run('--lines', '7', '7', '7', '7', '7', '7', '--at', '2026-08-07T19:42:43', '--timezone', 'Asia/Shanghai', '--canonical');
  const prev = run('--lines', '7', '7', '7', '7', '7', '7', '--at', '2026-08-06T23:30:00', '--timezone', 'Asia/Shanghai', '--canonical');
  check('交接前一秒：前=大暑 后=立秋', before.json?.calendar?.solarTermWindow?.previous === '大暑' && before.json?.calendar?.solarTermWindow?.next === '立秋', JSON.stringify(before.json?.calendar?.solarTermWindow));
  check('交接当秒：前=立秋 后=处暑', at.json?.calendar?.solarTermWindow?.previous === '立秋' && at.json?.calendar?.solarTermWindow?.next === '处暑', JSON.stringify(at.json?.calendar?.solarTermWindow));
  check('前一日：前=大暑 后=立秋', prev.json?.calendar?.solarTermWindow?.previous === '大暑' && prev.json?.calendar?.solarTermWindow?.next === '立秋', JSON.stringify(prev.json?.calendar?.solarTermWindow));
  check('输出当地交接时刻', typeof at.json?.calendar?.solarTermWindow?.previousAt === 'string' && at.json.calendar.solarTermWindow.previousAt.startsWith('2026-08-07'), `previousAt=${at.json?.calendar?.solarTermWindow?.previousAt ?? '(无)'}`);
  check('交接前一秒月柱仍为乙未', before.json?.calendar?.monthGanzhi === '乙未', `月柱=${before.json?.calendar?.monthGanzhi}`);
  check('交接当秒月柱变为丙申', at.json?.calendar?.monthGanzhi === '丙申', `月柱=${at.json?.calendar?.monthGanzhi}`);
}

console.log('\n=== 证据项 2：年柱两种口径分列 ===');
{
  const spring = run('--lines', '7', '7', '7', '7', '7', '7', '--at', '2024-02-08T12:00:00', '--timezone', 'Asia/Shanghai', '--canonical');
  check('农历年柱 = 癸卯', spring.json?.calendar?.yearGanzhi === '癸卯', `yearGanzhi=${spring.json?.calendar?.yearGanzhi}`);
  check('立春换年柱 = 甲辰（另行命名）', spring.json?.calendar?.yearGanzhiByLiChun === '甲辰', `yearGanzhiByLiChun=${spring.json?.calendar?.yearGanzhiByLiChun}`);
  check('节令月柱 = 丙寅', spring.json?.calendar?.monthGanzhi === '丙寅', `monthGanzhi=${spring.json?.calendar?.monthGanzhi}`);
}

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
