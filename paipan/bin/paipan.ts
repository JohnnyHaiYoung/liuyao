#!/usr/bin/env node
/**
 * 排盘命令行入口（阶段 3）
 *
 * 用法：
 *   node paipan/bin/paipan.ts --lines 8 7 8 8 8 7 --day 戊辰 --month 申
 *   node paipan/bin/paipan.ts --lines 6 7 8 9 7 8 --at 2026-09-06T20:00:00 --timezone Asia/Shanghai --day-boundary zi23
 *
 * 输入约束（验收报告 P1-1）：
 *   --lines 只接受字符串 6/7/8/9（不接受 7abc、7.5、空值、超量或不足）；
 *   需要值的参数缺值时报 missing_option_value；--at 与 --day/--month 同时出现时报 conflicting_calendar_mode；
 *   原始爻值字符串会原样回显在 input.rawLineValues，便于追溯。
 */
import { buildChart, canonicalize } from '../src/core.ts';
import { PaipanError, fromManual, fromMoment, type CalendarContext } from '../src/calendar.ts';

const USAGE = `用法：
  node paipan/bin/paipan.ts --lines 8 7 8 8 8 7 --day 戊辰 --month 申
  node paipan/bin/paipan.ts --lines 6 7 8 9 7 8 --at 2026-09-06T20:00:00 --timezone Asia/Shanghai [--day-boundary zi23|midnight]

参数：
  --lines <6 个 6/7/8/9>   初爻在前（必需；只接受这四个字符本身）
  --at <当地民用时间>       自动历法模式；形如 2026-09-06T20:00:00
  --timezone <IANA>        自动历法模式必需；本版仅支持 Asia/Shanghai
  --day-boundary <口径>     zi23（默认，23:00 换日）或 midnight（00:00 换日）
  --day <干支> --month <地支>  手动历法模式（须成对给出；日柱须为合法六十甲子）
  --canonical              输出去掉审计元数据的规范化结果
  --help                   显示本帮助
`;

function fail(code: string, message: string): never {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  process.exit(2);
}

const REQUIRE_VALUE = new Set(['lines', 'at', 'timezone', 'day-boundary', 'day', 'month']);
const KNOWN_FLAGS = new Set([...REQUIRE_VALUE, 'canonical', 'pretty', 'help']);

const argv = process.argv.slice(2);
const values = new Map<string, string | string[] | boolean>();
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index]!;
  if (!token.startsWith('--')) fail('unexpected_argument', `无法识别的参数：${token}（所有参数都必须以 -- 开头）`);
  const name = token.slice(2);
  if (!KNOWN_FLAGS.has(name)) fail('unknown_option', `未知参数：--${name}`);
  if (!REQUIRE_VALUE.has(name)) {
    values.set(name, true);
    continue;
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) fail('missing_option_value', `--${name} 需要值，但没有提供`);
  if (name === 'lines') {
    const list: string[] = [];
    let cursor = index + 1;
    while (cursor < argv.length && !argv[cursor]!.startsWith('--')) {
      list.push(argv[cursor]!);
      cursor += 1;
    }
    values.set(name, list);
    index = cursor - 1;
    continue;
  }
  if (values.has(name)) fail('duplicate_option', `--${name} 出现了多次`);
  values.set(name, next);
  index += 1;
}

if (values.get('help') === true) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const rawLines = values.get('lines');
if (!Array.isArray(rawLines)) fail('missing_option_value', '需要 --lines，且恰好 6 个值（初爻在前）');
if (rawLines.length !== 6) {
  fail('invalid_line_value', `--lines 需要恰好 6 个值（初爻在前）；收到 ${rawLines.length} 个：${rawLines.join(' ')}`);
}
for (const [index, raw] of rawLines.entries()) {
  if (!['6', '7', '8', '9'].includes(raw)) {
    fail(
      'invalid_line_value',
      `第 ${index + 1} 个爻值必须是字符串 "6"、"7"、"8" 或 "9"（初爻在前）；收到「${raw}」。不接受小数、字母或其它写法。`,
    );
  }
}
const lineValues = rawLines.map((raw) => Number.parseInt(raw, 10));

const at = values.get('at');
const timezone = values.get('timezone');
const dayBoundaryRaw = values.get('day-boundary');
const day = values.get('day');
const month = values.get('month');

if (typeof at === 'string' && (typeof day === 'string' || typeof month === 'string')) {
  fail(
    'conflicting_calendar_mode',
    '同时提供了 --at（自动历法）与 --day/--month（手动历法）。两条路径只能选一条；本项目拒绝静默让其一覆盖另一条。',
  );
}
if (dayBoundaryRaw !== undefined && typeof dayBoundaryRaw === 'string' && typeof at !== 'string') {
  fail('conflicting_calendar_mode', '--day-boundary 只适用于 --at（自动历法）路径；手动历法模式不涉及日界换算');
}
if (typeof timezone === 'string' && typeof at !== 'string') {
  fail('conflicting_calendar_mode', '--timezone 只适用于 --at（自动历法）路径；手动历法模式的日柱/月建由调用方声明');
}

let calendar: CalendarContext | null = null;
try {
  if (typeof at === 'string') {
    if (typeof timezone !== 'string') {
      fail('missing_timezone', '自动历法模式必须显式提供 --timezone（本版仅支持 Asia/Shanghai）；不接受隐式服务器时区');
    }
    const dayBoundary = dayBoundaryRaw === 'midnight' ? 'midnight' : 'zi23';
    if (dayBoundaryRaw !== undefined && dayBoundaryRaw !== 'zi23' && dayBoundaryRaw !== 'midnight') {
      fail('invalid_day_boundary', `--day-boundary 只能是 zi23 或 midnight；收到 ${String(dayBoundaryRaw)}`);
    }
    calendar = fromMoment({ castAt: at, timezone, dayBoundary });
  } else if (typeof day === 'string' || typeof month === 'string') {
    if (typeof day !== 'string' || typeof month !== 'string') {
      fail('incomplete_manual_calendar', '手动历法模式必须同时提供 --day 与 --month（本模块不猜填另一半）');
    }
    calendar = fromManual(day, month);
  }
} catch (error) {
  if (error instanceof PaipanError) fail(error.code, error.message);
  fail('calendar_error', error instanceof Error ? error.message : String(error));
}

try {
  const result = buildChart(lineValues, calendar, { rawLineValues: rawLines });
  const output = values.get('canonical') === true ? canonicalize(result) : result;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  if (error instanceof PaipanError) fail(error.code, error.message);
  fail('build_error', error instanceof Error ? error.message : String(error));
}
