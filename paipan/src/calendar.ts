/**
 * 历法适配器（阶段 3）
 *
 * 口径与证据见 docs/phase3_calendar_decision.md：
 *   - 主实现 lunar-typescript@1.8.6（MIT，零运行时依赖），生产链路不依赖 Python；
 *   - 月建按节气交接时刻（getMonthInGanZhiExact），日界显式映射（zi23→Exact / midnight→Exact2）；
 *   - 时区白名单：首版仅 Asia/Shanghai，其它时区明确拒绝；
 *   - 自行做严格公历校验（上游对 2026-02-30 会静默溢出）；
 *   - 支持范围 1901-01-01 至 2099-12-31（保守声明）。
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

export interface CalendarContext {
  mode: CalendarMode;
  dayGanzhi: string;
  monthBranch: string;
  monthGanzhi?: string;
  yearGanzhi?: string;
  hourGanzhi?: string;
  timezone?: string;
  dayBoundary?: DayBoundary;
  localCivilTime?: string;
  solarTermWindow?: { previous: string; next: string };
  library: string;
  evidence: string;
}

export interface AutoCalendarInput {
  /** 当地民用时间，形如 2026-09-06T20:00:00（不带时区偏移，按 timezone 解释） */
  castAt: string;
  timezone: string;
  dayBoundary?: DayBoundary;
}

/** 严格公历校验：拒绝 2026-02-30 这类上游会静默溢出的输入。 */
export function parseStrictLocalTime(castAt: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(castAt.trim());
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

/** 时区校验：白名单 + Node 原生 Intl（full ICU）验证。 */
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

/** 自动历法路径：由时刻计算日柱/月建（含节气窗口），需要时区与日界。 */
export function fromMoment(input: AutoCalendarInput): CalendarContext {
  assertTimezone(input.timezone);
  const dayBoundary: DayBoundary = input.dayBoundary ?? 'zi23';
  const { year, month, day, hour, minute, second } = parseStrictLocalTime(input.castAt);
  assertInRange(year, month, day);
  const lunar = Solar.fromYmdHms(year, month, day, hour, minute, second).getLunar();
  const dayGanzhi = dayBoundary === 'zi23' ? lunar.getDayInGanZhiExact() : lunar.getDayInGanZhiExact2();
  const monthGanzhi = lunar.getMonthInGanZhiExact();
  return {
    mode: 'auto_calendar',
    dayGanzhi,
    monthBranch: monthGanzhi.slice(-1),
    monthGanzhi,
    yearGanzhi: lunar.getYearInGanZhi(),
    hourGanzhi: lunar.getTimeInGanZhi(),
    timezone: input.timezone,
    dayBoundary,
    localCivilTime: `${input.castAt}`,
    solarTermWindow: { previous: lunar.getPrevJieQi(true).getName(), next: lunar.getNextJieQi(true).getName() },
    library: 'lunar-typescript@1.8.6',
    evidence: 'corpus_original_page + independent_implementation（见 docs/phase3_calendar_decision.md §3）',
  };
}

/** 手动历法路径：使用外部已核实的日柱/月建，不冒充自动计算。 */
export function fromManual(dayGanzhi: string, monthBranch: string): CalendarContext {
  const branches = '子丑寅卯辰巳午未申酉戌亥';
  if (!/^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/.test(dayGanzhi)) {
    throw new PaipanError('invalid_day_ganzhi', `日柱应为干支两字（如 戊辰），收到：${dayGanzhi}`);
  }
  if (monthBranch.length !== 1 || !branches.includes(monthBranch)) {
    throw new PaipanError('invalid_month_branch', `月建应为地支单字（如 申），收到：${monthBranch}`);
  }
  return {
    mode: 'manual_calendar',
    dayGanzhi,
    monthBranch,
    library: 'externally_supplied',
    evidence: '调用方声明的已知日柱/月建；本模块不校验其历法来源',
  };
}
