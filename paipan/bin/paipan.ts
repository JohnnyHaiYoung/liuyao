#!/usr/bin/env node
/**
 * 排盘命令行入口（阶段 3）
 *
 * 用法：
 *   node paipan/bin/paipan.ts --lines 8 7 8 8 8 7 --day 戊辰 --month 申
 *   node paipan/bin/paipan.ts --lines 6 7 8 9 7 8 --at 2026-09-06T20:00:00 --timezone Asia/Shanghai --day-boundary zi23
 *
 * 说明：
 *   --lines 固定按初爻至上爻输入（6 老阴、7 少阳、8 少阴、9 老阳）；
 *   --at 按 --timezone 指定的当地民用时间解释；自动历法模式必须显式给时区；
 *   既不给 --at 也不给 --day/--month 时，输出可独立计算的字段，六神/旬空/月建相关字段为 null 并附原因；
 *   --canonical 输出去掉审计元数据的规范化结果，便于比较稳定性。
 */
import { buildChart, canonicalize } from '../src/core.ts';
import { PaipanError, fromManual, fromMoment, type CalendarContext } from '../src/calendar.ts';

interface ParsedArgs {
  values: Map<string, string | string[] | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string | string[] | boolean>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      index += 1;
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      values.set(name, true);
      index += 1;
      continue;
    }
    if (name === 'lines') {
      const list: string[] = [];
      let cursor = index + 1;
      while (cursor < argv.length && !argv[cursor]!.startsWith('--')) {
        list.push(argv[cursor]!);
        cursor += 1;
      }
      values.set(name, list);
      index = cursor;
      continue;
    }
    values.set(name, next);
    index += 2;
  }
  return { values };
}

const USAGE = `用法：
  node paipan/bin/paipan.ts --lines 8 7 8 8 8 7 --day 戊辰 --month 申
  node paipan/bin/paipan.ts --lines 6 7 8 9 7 8 --at 2026-09-06T20:00:00 --timezone Asia/Shanghai [--day-boundary zi23|midnight]

参数：
  --lines <6 个 6/7/8/9>   初爻在前（必需）
  --at <当地民用时间>       自动历法模式；形如 2026-09-06T20:00:00
  --timezone <IANA>        自动历法模式必需；本版仅支持 Asia/Shanghai
  --day-boundary <口径>     zi23（默认，23:00 换日）或 midnight（00:00 换日）
  --day <干支> --month <地支>  手动历法模式（须成对给出）
  --canonical              输出去掉审计元数据的规范化结果
  --pretty                 美化输出（默认已美化）
`;

function fail(code: string, message: string): never {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  process.exit(2);
}

const { values } = parseArgs(process.argv.slice(2));
if (values.get('help') === true) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const rawLines = values.get('lines');
if (!Array.isArray(rawLines) || rawLines.length !== 6) {
  fail('invalid_line_value', `--lines 需要恰好 6 个值（初爻在前）；收到 ${Array.isArray(rawLines) ? rawLines.length : 0} 个`);
}
const lineValues = (rawLines as string[]).map((item) => Number.parseInt(item, 10));
if (lineValues.some((value) => Number.isNaN(value))) {
  fail('invalid_line_value', `--lines 只能包含 6/7/8/9；收到 ${JSON.stringify(rawLines)}`);
}

const at = values.get('at');
const timezone = values.get('timezone');
const dayBoundaryRaw = values.get('day-boundary');
const day = values.get('day');
const month = values.get('month');

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
  const result = buildChart(lineValues, calendar);
  const output = values.get('canonical') === true ? canonicalize(result) : result;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  if (error instanceof PaipanError) fail(error.code, error.message);
  fail('build_error', error instanceof Error ? error.message : String(error));
}
