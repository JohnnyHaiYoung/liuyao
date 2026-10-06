#!/usr/bin/env node
/**
 * 服务端排盘适配层自检（阶段 4 任务书第 4、7.3 节）。
 *
 * 关键断言：app 服务端排盘结果与阶段 3 CLI 的 `--canonical` 输出**逐字段一致**（同一份 core），
 * 且缺项/非法输入不产出盘面、绝不使用发送时间或服务器时区补全。
 *
 * 用法：node app/scripts/check-chart-service.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChartRun, extractChartInputFromText } from '../src/server/chart/service.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const cli = path.join(projectRoot, 'paipan', 'bin', 'paipan.ts');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};

const runCli = (args) => {
  const result = spawnSync('node', [cli, ...args, '--canonical'], { encoding: 'utf8', windowsHide: true });
  const stdout = (result.stdout ?? '').replace(/^\uFEFF/, '');
  if (result.status !== 0) throw new Error(`CLI 退出 ${result.status}：${(result.stderr ?? '').slice(0, 160)}`);
  return JSON.parse(stdout);
};

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('=== 1) 与阶段 3 CLI 的 canonical 盘面逐字段一致 ===');
for (const [label, lineValues, dayGanzhi, monthBranch] of [
  ['静卦（山水蒙）', [8, 7, 8, 8, 8, 7], '戊辰', '申'],
  ['多动爻（山天大畜→天泽履）', [7, 7, 9, 6, 6, 7], '戊戌', '亥'],
  ['老阴老阳（6/9 并用）', [6, 9, 7, 8, 8, 6], '庚午', '巳'],
]) {
  const service = createChartRun({ lineValues, mode: 'manual_calendar', dayGanzhi, monthBranch });
  if (!service.ok) {
    check(`${label} 服务端排盘成功`, false, `${service.errorCode}: ${service.message}`);
    continue;
  }
  const cliChart = runCli(['--lines', ...lineValues.map(String), '--day', dayGanzhi, '--month', monthBranch]);
  const same = deepEqual(service.chart, cliChart);
  check(`${label} 与 CLI canonical 完全一致`, same, same ? `${service.chart.chart.original.name} 宫${service.chart.chart.palace.name} 世${service.chart.chart.shiPosition}应${service.chart.chart.yingPosition}` : '存在字段差异');
  if (!same) {
    const a = JSON.stringify(service.chart);
    const b = JSON.stringify(cliChart);
    let index = 0;
    while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
    check(`${label} 差异定位`, false, `首个差异在第 ${index} 字符附近：服务端「${a.slice(index, index + 60)}」CLI「${b.slice(index, index + 60)}」`);
  }
}

console.log('\n=== 2) 自动历法（显式时刻 + 显式时区） ===');
{
  const service = createChartRun({
    lineValues: [8, 7, 8, 8, 8, 7],
    mode: 'auto_calendar',
    castAt: '2006-05-10T14:22:00',
    timezone: 'Asia/Shanghai',
    dayBoundary: 'zi23',
  });
  check('自动历法排盘成功', service.ok, service.ok ? '' : `${service.errorCode}: ${service.message}`);
  if (service.ok) {
    check('日柱/月柱/时柱与原页锚点一致', service.calendar.dayGanzhi === '己亥' && service.calendar.monthGanzhi === '癸巳' && service.calendar.hourGanzhi === '辛未', `${service.calendar.dayGanzhi}/${service.calendar.monthGanzhi}/${service.calendar.hourGanzhi}`);
    check('记录历法来源为自动计算', service.calendar.mode === 'auto_calendar' && service.calendar.library === 'lunar-typescript@1.8.6', `${service.calendar.mode} / ${service.calendar.library}`);
    const cli = runCli(['--lines', '8', '7', '8', '8', '8', '7', '--at', '2006-05-10T14:22:00', '--timezone', 'Asia/Shanghai', '--day-boundary', 'zi23']);
    check('与 CLI 自动历法结果一致', deepEqual(service.chart, cli), service.chart.calendar?.dayGanzhi ?? '');
  }
}

console.log('\n=== 3) 缺项只追问、不补全 ===');
{
  const noCalendar = createChartRun({ lineValues: [8, 7, 8, 8, 8, 7] });
  check('缺历法 → chart_input_incomplete', !noCalendar.ok && noCalendar.errorCode === 'chart_input_incomplete', noCalendar.ok ? '竟然成功' : noCalendar.errorCode);
  check('缺项含 calendar 与 lineValues 之外的信息', !noCalendar.ok && noCalendar.missingInputs.includes('calendar'), noCalendar.ok ? '' : noCalendar.missingInputs.join(','));

  const noTimezone = createChartRun({ lineValues: [8, 7, 8, 8, 8, 7], mode: 'auto_calendar', castAt: '2026-09-06T20:00:00' });
  check('自动模式缺时区 → missing_timezone 且不排盘', !noTimezone.ok && noTimezone.errorCode === 'missing_timezone' && noTimezone.missingInputs.includes('timezone'), noTimezone.ok ? '竟然成功' : `${noTimezone.errorCode} missing=${noTimezone.missingInputs.join(',')}`);

  const noLines = createChartRun({ mode: 'auto_calendar', castAt: '2026-09-06T20:00:00', timezone: 'Asia/Shanghai' });
  check('缺爻值 → chart_input_incomplete 且 missing 含 lineValues', !noLines.ok && noLines.missingInputs.includes('lineValues'), noLines.ok ? '竟然成功' : noLines.missingInputs.join(','));

  const halfManual = createChartRun({ lineValues: [8, 7, 8, 8, 8, 7], mode: 'manual_calendar', dayGanzhi: '戊辰' });
  check('手动历法只给一半 → 不排盘', !halfManual.ok && halfManual.errorCode === 'chart_input_incomplete', halfManual.ok ? '竟然成功' : halfManual.errorCode);
}

console.log('\n=== 4) 非法输入与冲突 ===');
{
  const cases = [
    ['非法爻值 5', { lineValues: [5, 7, 8, 8, 8, 7], mode: 'manual_calendar', dayGanzhi: '戊辰', monthBranch: '申' }, 'invalid_line_value'],
    ['爻值字符串 7abc', { lineValues: ['7abc', 7, 8, 8, 8, 7], mode: 'manual_calendar', dayGanzhi: '戊辰', monthBranch: '申' }, 'invalid_line_value'],
    ['爻值个数不足', { lineValues: [7, 7, 8], mode: 'manual_calendar', dayGanzhi: '戊辰', monthBranch: '申' }, 'invalid_line_value'],
    ['非法日柱 甲丑', { lineValues: [7, 7, 8, 8, 8, 7], mode: 'manual_calendar', dayGanzhi: '甲丑', monthBranch: '申' }, 'invalid_day_ganzhi'],
    ['非法月建', { lineValues: [7, 7, 8, 8, 8, 7], mode: 'manual_calendar', dayGanzhi: '戊辰', monthBranch: '春' }, 'invalid_month_branch'],
    ['未验证时区', { lineValues: [7, 7, 8, 8, 8, 7], mode: 'auto_calendar', castAt: '2026-09-06T20:00:00', timezone: 'America/New_York' }, 'unsupported_timezone'],
    ['无效日期 2026-02-30', { lineValues: [7, 7, 8, 8, 8, 7], mode: 'auto_calendar', castAt: '2026-02-30T10:00:00', timezone: 'Asia/Shanghai' }, 'invalid_date'],
    ['超出支持范围', { lineValues: [7, 7, 8, 8, 8, 7], mode: 'auto_calendar', castAt: '2100-01-01T10:00:00', timezone: 'Asia/Shanghai' }, 'out_of_range'],
    ['自动与手动冲突', { lineValues: [7, 7, 8, 8, 8, 7], mode: 'auto_calendar', castAt: '2026-09-06T20:00:00', timezone: 'Asia/Shanghai', dayGanzhi: '戊辰', monthBranch: '申' }, 'conflicting_calendar_mode'],
    ['非法日界', { lineValues: [7, 7, 8, 8, 8, 7], mode: 'auto_calendar', castAt: '2026-09-06T20:00:00', timezone: 'Asia/Shanghai', dayBoundary: 'noon' }, 'invalid_day_boundary'],
  ];
  for (const [label, input, expected] of cases) {
    const result = createChartRun(input);
    check(label, !result.ok && result.errorCode === expected, result.ok ? '竟然成功' : result.errorCode);
  }
}

console.log('\n=== 5) 快照哈希稳定性 ===');
{
  const a = createChartRun({ lineValues: [8, 7, 8, 8, 8, 7], mode: 'manual_calendar', dayGanzhi: '戊辰', monthBranch: '申' });
  const b = createChartRun({ lineValues: [8, 7, 8, 8, 8, 7], mode: 'manual_calendar', dayGanzhi: '戊辰', monthBranch: '申' });
  const c = createChartRun({ lineValues: [8, 7, 8, 8, 8, 8], mode: 'manual_calendar', dayGanzhi: '戊辰', monthBranch: '申' });
  check('同输入两次哈希相同', a.ok && b.ok && a.canonicalHash === b.canonicalHash, a.ok ? a.canonicalHash.slice(0, 16) + '…' : '');
  check('不同输入哈希不同', a.ok && c.ok && a.canonicalHash !== c.canonicalHash, '');
  check('哈希与规则/核心版本一并返回', a.ok && a.ruleProfileVersion === 'liuyao-rule-profile.v1' && a.coreVersion.startsWith('paipan-core/'), a.ok ? `${a.ruleProfileVersion} / ${a.coreVersion}` : '');
}

console.log('\n=== 6) 自由文本提取（保守，不含糊就绝不猜） ===');
{
  const grouped = extractChartInputFromText('爻值 8 7 8 8 8 7，时间 2026-09-06 20:00，北京时间');
  check('带分隔符的六爻值可提取', grouped.lineValues?.join('') === '878887', JSON.stringify(grouped.lineValues));
  check('日期+钟点可提取为 castAt', grouped.castAt === '2026-09-06T20:00:00', String(grouped.castAt));
  check('显式时区映射为 Asia/Shanghai', grouped.timezone === 'Asia/Shanghai', String(grouped.timezone));

  const runOfDigits = extractChartInputFromText('我想用 878887 起一卦');
  check('连续六位数字判为含糊（不自动采用）', runOfDigits.lineValues === null && runOfDigits.ambiguities.length > 0, runOfDigits.ambiguities[0] ?? '(无)');

  const dateOnly = extractChartInputFromText('2026-09-06 起卦，爻值 8 7 8 8 8 7');
  check('只有日期没有钟点 → 标含糊', dateOnly.castAt === null && dateOnly.ambiguities.some((item) => item.includes('钟点')), dateOnly.ambiguities.join(' | '));

  const noTimezone = extractChartInputFromText('爻值 8 7 8 8 8 7，2026-09-06 20:00');
  check('未写时区 → missing 含 timezone（不默认服务器时区）', noTimezone.timezone === null && noTimezone.missing.includes('timezone'), noTimezone.missing.join(','));

  const five = extractChartInputFromText('爻值是 8 7 8 8 8');
  check('只有五个爻值 → 标含糊且不采用', five.lineValues === null && five.ambiguities.some((item) => item.includes('6 个')), five.ambiguities.join(' | '));
}

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
