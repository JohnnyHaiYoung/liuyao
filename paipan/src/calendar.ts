/**
 * 历法适配器（阶段 3）
 *
 * 口径与证据见 docs/phase3_calendar_decision.md：
 *   - 主实现 lunar-typescript@1.8.6（MIT，零运行时依赖），生产链路不依赖 Python；
 *   - 月建按节气交接时刻（getMonthInGanZhiExact），日界显式映射（zi23→Exact / midnight→Exact2）；
 *   - 时区白名单：首版仅 Asia/Shanghai，其它时区明确拒绝；
 *   - 自行做严格公历校验（上游对 2026-02-30 会静默溢出）；
 *   - 支持范围 1901-01-01 至 2099-12-31（保守声明）；
 *   - 节气窗口按**交接时刻**判断（getPrevJieQi(false)/getNextJieQi(false)），并输出当地交接时间；
 *   - 年柱分列：`yearGanzhi` 为农历年（lunar-typescript 默认），`yearGanzhiByLiChun` 为立春换年
 *     （getYearInGanZhiExact）；两者不是同一四柱体系，字段名不得混用（验收报告 P1-4 与证据项 2）。
 */
import { Solar } from 'lunar-typescript';

export type DayBoundary = 'zi23' | 'midnight';
export type CalendarMode = 'auto_calendar' | 'manual_calendar';

export class PaipanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaipanError';
    this.code = code;
  }
}

export const SUPPORTED_TIMEZONES = ['Asia/Shanghai'];
export const SUPPORTED_RANGE = { from: '1901-01-01', to: '2099-12-31' };

const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';

/** 六十甲子：干阳配阳支、阴配阴支（干支索引同奇偶）。 */
export function isSexagenary(ganzhi: string): boolean {
  if (typeof ganzhi !== 'string' || ganzhi.length !== 2) return false;
  const stem = STEMS.indexOf(ganzhi[0]!);
  const branch = BRANCHES.indexOf(ganzhi[1]!);
  if (stem < 0 || branch < 0) return false;
  return (stem - branch) % 2 === 0;
}

export function sexagenaryCycle(): string[] {
  const list: string[] = [];
  for (let index = 0; index < 60; index += 1) list.push(`${STEMS[index % 10]}${BRANCHES[index % 12]}`);
  return list;
}

export interface SolarTermWindow {
  previous: string;
  next: string;
  /** 当地交接时间（形如 2026-08-07 19:42:43），按时刻判断，供核对 */
  previousAt?: string;
  nextAt?: string;
}

export interface CalendarContext {
  mode: CalendarMode;
  source: string;
  dayGanzhi: string;
  monthBranch: string;
  monthGanzhi?: string;
  /** 农历年柱（lunar-typescript 默认口径） */
  yearGanzhi?: string;
  /** 立春换年口径的年柱；与 yearGanzhi 不是同一体系，分别命名 */
  yearGanzhiByLiChun?: string;
  hourGanzhi?: string;
  timezone?: string;
  dayBoundary?: DayBoundary;
  localCivilTime?: string;
  solarTermWindow?: SolarTermWindow;
  library: string;
  evidence: string;
}

export interface AutoCalendarInput {
  castAt: string;
  timezone: string;
  dayBoundary?: DayBoundary;
}

/** 严格公历校验：拒绝 2026-02-30 这类上游会静默溢出的输入。 */
export function parseStrictLocalTime(castAt: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(castAt).trim());
  if (!match) throw new PaipanError('invalid_datetime', `时间格式应为 YYYY-MM-DDTHH:mm[:ss]，收到：${castAt}`);
  const [year, month, day, hour, minute] = [match[1], match[2], match[3], match[4], match[5]].map((value) => Number.parseInt(value!, 10));
  const second = match[6] ? Number.parseInt(match[6], 10) : 0;
  if (month! < 1 || month! > 12) throw new PaipanError('invalid_date', `月份非法：${month}`);
  if (day! < 1 || day! > 31) throw new PaipanError('invalid_date', `日期非法：${day}`);
  if (hour! > 23 || minute! > 59 || second! > 59) throw new PaipanError('invalid_time', `时间分量非法：${castAt}`);
  const probe = new Date(Date.UTC(year!, month! - 1, day!));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month! - 1 || probe.getUTCDate() !== day) {
    throw new PaipanError('invalid_date', `公历日期不存在：${match[1]}-${match[2]}-${match[3]}（注意闰年与月长）`);
  }
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second };
}

export function assertTimezone(timezone: string): void {
  if (!SUPPORTED_TIMEZONES.includes(timezone)) {
    throw new PaipanError(
      'unsupported_timezone',
      `本版只支持已验证的时区 ${SUPPORTED_TIMEZONES.join('、')}；收到 ${timezone}。其它时区尚未验证，明确拒绝而不回退默认值。`,
    );
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch {
    throw new PaipanError('invalid_timezone', `Node 无法识别该 IANA 时区：${timezone}`);
  }
}

function assertInRange(year: number, month: number, day: number): void {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (value < SUPPORTED_RANGE.from || value > SUPPORTED_RANGE.to) {
    throw new PaipanError('out_of_range', `日期 ${value} 超出本版声明支持范围 ${SUPPORTED_RANGE.from} 至 ${SUPPORTED_RANGE.to}`);
  }
}

const formatLocal = (solar: { getYear(): number; getMonth(): number; getDay(): number; getHour(): number; getMinute(): number; getSecond(): number }): string =>
  `${String(solar.getYear()).padStart(4, '0')}-${String(solar.getMonth()).padStart(2, '0')}-${String(solar.getDay()).padStart(2, '0')} ` +
  `${String(solar.getHour()).padStart(2, '0')}:${String(solar.getMinute()).padStart(2, '0')}:${String(solar.getSecond()).padStart(2, '0')}`;

/** 自动历法路径：由时刻计算日柱/月建（含按时刻的节气窗口），需要时区与日界。 */
export function fromMoment(input: AutoCalendarInput): CalendarContext {
  assertTimezone(input.timezone);
  const dayBoundary: DayBoundary = input.dayBoundary ?? 'zi23';
  const { year, month, day, hour, minute, second } = parseStrictLocalTime(input.castAt);
  assertInRange(year, month, day);
  const solar = Solar.fromYmdHms(year, month, day, hour, minute, second);
  const lunar = solar.getLunar();
  const dayGanzhi = dayBoundary === 'zi23' ? lunar.getDayInGanZhiExact() : lunar.getDayInGanZhiExact2();
  const monthGanzhi = lunar.getMonthInGanZhiExact();
  // 按时刻判断前后节气（false = 精确到交接时刻；true 为按天，会提前跳转）
  const prevJie = lunar.getPrevJieQi(false);
  const nextJie = lunar.getNextJieQi(false);
  return {
    mode: 'auto_calendar',
    source: 'command_line:--at/--timezone/--day-boundary',
    dayGanzhi,
    monthBranch: monthGanzhi.slice(-1),
    monthGanzhi,
    yearGanzhi: lunar.getYearInGanZhi(),
    yearGanzhiByLiChun: lunar.getYearInGanZhiExact(),
    hourGanzhi: lunar.getTimeInGanZhi(),
    timezone: input.timezone,
    dayBoundary,
    localCivilTime: input.castAt,
    solarTermWindow: {
      previous: prevJie.getName(),
      next: nextJie.getName(),
      previousAt: formatLocal(prevJie.getSolar()),
      nextAt: formatLocal(nextJie.getSolar()),
    },
    library: 'lunar-typescript@1.8.6',
    evidence: 'corpus_original_page + independent_implementation（见 docs/phase3_calendar_decision.md §3）',
  };
}

/** 手动历法路径：使用外部已核实的日柱/月建，不冒充自动计算。 */
export function fromManual(dayGanzhi: string, monthBranch: string): CalendarContext {
  if (!isSexagenary(String(dayGanzhi))) {
    throw new PaipanError(
      'invalid_day_ganzhi',
      `日柱必须是六十甲子之一（如 戊辰）；收到「${dayGanzhi}」。注意阳干只配阳支、阴干只配阴支（甲丑、乙子等不存在）。`,
    );
  }
  if (typeof monthBranch !== 'string' || monthBranch.length !== 1 || !BRANCHES.includes(monthBranch)) {
    throw new PaipanError('invalid_month_branch', `月建应为地支单字（如 申），收到：${monthBranch}`);
  }
  return {
    mode: 'manual_calendar',
    source: 'command_line:--day/--month（外部提供的已知日柱与月建）',
    dayGanzhi,
    monthBranch,
    library: 'externally_supplied',
    evidence: '调用方声明的已知日柱/月建；本模块只校验其为合法六十甲子与地支，不校验其历法来源',
  };
}
