/**
 * 服务端排盘适配层（阶段 4 任务书第 4 节）
 *
 * 设计要点：
 *   - 排盘只能由这里调用阶段 3 模块完成；前端与模型都不能改盘面字段，也不能自己算；
 *   - 复用 `paipan/rules/rule-profile.v1.json` 的规则版本号，不把算法重写进提示词或浏览器；
 *   - 输入不齐时**只返回缺项**（missingInputs），绝不拿发送时间或服务器时区补全；
 *   - 计算成功即产出 canonical JSON 与稳定哈希，供 SQLite 快照与历史回看使用。
 *
 * 该模块只依赖 `liuyao-paipan`（仓库内阶段 3 模块）与 node:*，因此可被离线脚本直接调用。
 */
import crypto from 'node:crypto';
import {
  buildChart,
  canonicalize,
  fromManual,
  fromMoment,
  PaipanError,
  SUPPORTED_RANGE,
  SUPPORTED_TIMEZONES,
  type CalendarContext,
  type ChartResult,
  type DayBoundary,
} from 'liuyao-paipan';

export type ChartErrorCode =
  | 'chart_input_incomplete'
  | 'invalid_line_value'
  | 'invalid_day_ganzhi'
  | 'invalid_month_branch'
  | 'missing_timezone'
  | 'unsupported_timezone'
  | 'invalid_datetime'
  | 'invalid_date'
  | 'invalid_time'
  | 'out_of_range'
  | 'conflicting_calendar_mode'
  | 'invalid_day_boundary';

export type MissingInput = 'lineValues' | 'castTime' | 'timezone' | 'calendar';

export interface ChartInput {
  /** 六次爻值，初爻在前；来自显式结构化输入或从文本中提取的候选 */
  lineValues?: (number | string)[] | null;
  mode?: 'auto_calendar' | 'manual_calendar' | 'none';
  castAt?: string | null;
  timezone?: string | null;
  dayBoundary?: DayBoundary | null;
  dayGanzhi?: string | null;
  monthBranch?: string | null;
  /** 用户原话（保存到快照，便于追溯"这句话生成了这个盘"） */
  sourceInput?: string | null;
}

export interface ChartRunSuccess {
  ok: true;
  /** canonical 盘面（不含 audit 时间戳），可直接落库为快照 */
  chart: Omit<ChartResult, 'audit'>;
  canonicalJson: string;
  canonicalHash: string;
  ruleProfileVersion: string;
  coreVersion: string;
  calendar: CalendarContext;
  /** 排盘输入的规范化副本（落库用） */
  normalized: {
    lineValues: number[];
    mode: 'auto_calendar' | 'manual_calendar';
    castAt: string | null;
    timezone: string | null;
    dayBoundary: DayBoundary | null;
    dayGanzhi: string | null;
    monthBranch: string | null;
  };
}

export interface ChartRunFailure {
  ok: false;
  errorCode: ChartErrorCode;
  message: string;
  missingInputs: MissingInput[];
}

export type ChartRunResult = ChartRunSuccess | ChartRunFailure;

const YAO_STRINGS = new Set(['6', '7', '8', '9']);

/** 校验并规范化入参；只判断"够不够算"，不做任何补全。 */
export function normalizeChartInput(input: ChartInput): { ok: true; normalized: NonNullable<ChartRunSuccess['normalized']>; calendar: CalendarContext } | ChartRunFailure {
  const missing: MissingInput[] = [];

  const rawLines = input.lineValues ?? null;
  let lineValues: number[] | null = null;
  if (rawLines === null) {
    missing.push('lineValues');
  } else {
    if (!Array.isArray(rawLines) || rawLines.length !== 6) {
      return {
        ok: false,
        errorCode: 'invalid_line_value',
        message: `需要恰好 6 个爻值（初爻在前）；收到 ${Array.isArray(rawLines) ? rawLines.length : 0} 个`,
        missingInputs: ['lineValues'],
      };
    }
    const parsed: number[] = [];
    for (const [index, raw] of rawLines.entries()) {
      const text = typeof raw === 'number' ? String(raw) : String(raw).trim();
      if (!YAO_STRINGS.has(text)) {
        return {
          ok: false,
          errorCode: 'invalid_line_value',
          message: `第 ${index + 1} 个爻值必须是 6/7/8/9 之一（初爻在前）；收到「${String(raw).slice(0, 20)}」`,
          missingInputs: [],
        };
      }
      parsed.push(Number.parseInt(text, 10));
    }
    lineValues = parsed;
  }

  const hasAuto = typeof input.castAt === 'string' && input.castAt.trim() !== '';
  const hasManual = (typeof input.dayGanzhi === 'string' && input.dayGanzhi.trim() !== '') || (typeof input.monthBranch === 'string' && input.monthBranch.trim() !== '');
  const declaredMode = input.mode ?? 'none';

  if (hasAuto && hasManual) {
    return {
      ok: false,
      errorCode: 'conflicting_calendar_mode',
      message: '同时提供了起卦时刻与已知日柱/月建；自动化历法与手动历法只能选一条，请明确其一。',
      missingInputs: [],
    };
  }

  // 先把"够不够算"一次判全，只追问必要缺项；此时不做任何补全（不用发送时间、不用服务器时区）
  if (!hasAuto && !hasManual) missing.push('calendar');
  if (hasAuto && (typeof input.timezone !== 'string' || input.timezone.trim() === '')) missing.push('timezone');

  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    const onlyTimezone = unique.length === 1 && unique[0] === 'timezone';
    return {
      ok: false,
      errorCode: onlyTimezone ? 'missing_timezone' : 'chart_input_incomplete',
      message: onlyTimezone
        ? `自动历法模式必须提供 IANA 时区（本版支持：${SUPPORTED_TIMEZONES.join('、')}）。服务器时区不会被当作起卦时区。`
        : '缺少排盘所需输入，请补齐后再试；本服务不会用发送时间或服务器时区代替，也不会猜爻序。',
      missingInputs: unique,
    };
  }

  try {
    if (hasAuto) {
      if (typeof input.timezone !== 'string' || input.timezone.trim() === '') {
        return {
          ok: false,
          errorCode: 'missing_timezone',
          message: `自动历法模式必须提供 IANA 时区（本版支持：${SUPPORTED_TIMEZONES.join('、')}）。服务器时区不会被当作起卦时区。`,
          missingInputs: [...new Set([...missing, 'timezone' as MissingInput])],
        };
      }
      if (declaredMode === 'manual_calendar') {
        return { ok: false, errorCode: 'conflicting_calendar_mode', message: '声明为手动历法，却提供了起卦时刻。', missingInputs: [] };
      }
      const dayBoundary = input.dayBoundary ?? 'zi23';
      if (dayBoundary !== 'zi23' && dayBoundary !== 'midnight') {
        return { ok: false, errorCode: 'invalid_day_boundary', message: `日界只能是 zi23 或 midnight；收到 ${String(input.dayBoundary)}`, missingInputs: [] };
      }
      const calendar = fromMoment({ castAt: input.castAt!.trim(), timezone: input.timezone.trim(), dayBoundary });
      return {
        ok: true,
        calendar,
        normalized: {
          lineValues: lineValues!,
          mode: 'auto_calendar',
          castAt: input.castAt!.trim(),
          timezone: input.timezone.trim(),
          dayBoundary,
          dayGanzhi: calendar.dayGanzhi,
          monthBranch: calendar.monthBranch,
        },
      };
    }

    if (typeof input.dayGanzhi !== 'string' || input.dayGanzhi.trim() === '' || typeof input.monthBranch !== 'string' || input.monthBranch.trim() === '') {
      return {
        ok: false,
        errorCode: 'chart_input_incomplete',
        message: '手动历法需要同时提供日柱与月建（本服务不猜填另一半）。',
        missingInputs: ['calendar'],
      };
    }
    const calendar = fromManual(input.dayGanzhi.trim(), input.monthBranch.trim());
    return {
      ok: true,
      calendar,
      normalized: {
        lineValues: lineValues!,
        mode: 'manual_calendar',
        castAt: null,
        timezone: null,
        dayBoundary: null,
        dayGanzhi: input.dayGanzhi.trim(),
        monthBranch: input.monthBranch.trim(),
      },
    };
  } catch (error) {
    if (error instanceof PaipanError) {
      return {
        ok: false,
        errorCode: (error.code as ChartErrorCode) ?? 'chart_input_incomplete',
        message: error.message,
        missingInputs: error.code === 'missing_timezone' ? ['timezone'] : [],
      };
    }
    throw error;
  }
}

export function canonicalHash(chart: ChartResult): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(chart)), 'utf8').digest('hex');
}

/** 生成一次排盘（新盘）。缺项/非法输入只返回失败信息，不产出半成品盘面。 */
export function createChartRun(input: ChartInput): ChartRunResult {
  const normalizedResult = normalizeChartInput(input);
  if (!normalizedResult.ok) return normalizedResult;

  try {
    const built = buildChart(normalizedResult.normalized.lineValues, normalizedResult.calendar);
    // 快照只保存 canonical（去掉 audit 时间戳），保证"同输入 → 同盘面哈希"可复验
    const chart = canonicalize(built);
    const canonicalJson = JSON.stringify(chart);
    return {
      ok: true,
      chart,
      canonicalJson,
      canonicalHash: crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
      ruleProfileVersion: chart.ruleProfileVersion,
      coreVersion: chart.coreVersion,
      calendar: normalizedResult.calendar,
      normalized: normalizedResult.normalized,
    };
  } catch (error) {
    if (error instanceof PaipanError) {
      return { ok: false, errorCode: (error.code as ChartErrorCode) ?? 'chart_input_incomplete', message: error.message, missingInputs: [] };
    }
    throw error;
  }
}

export interface TextExtraction {
  lineValues: number[] | null;
  castAt: string | null;
  timezone: string | null;
  /** 提取过程中的含糊点（例如爻序不明、时间只有日期没有钟点） */
  ambiguities: string[];
  missing: MissingInput[];
}

/**
 * 从自由文本里提取**候选**起卦输入（保守策略）。
 *
 * - 只认恰好 6 个以空白/逗号/顿号分隔的 6/7/8/9；连续 6 位数字串（如「678978」）判为含糊，不自动采用；
 * - 时间必须同时有日期与钟点才算可用；只出现日期或只出现钟点都记为含糊；
 * - 时区必须显式写出（如「北京时间」「Asia/Shanghai」）；
 * - 任何含糊都进 ambiguities，由编排层追问，绝不猜。
 */
export function extractChartInputFromText(text: string): TextExtraction {
  const ambiguities: string[] = [];
  const source = String(text ?? '');

  // 爻值：优先带分隔符的形式
  const separated = [...source.matchAll(/(?:^|[^\d])([6789])(?=[\s,，、/|]+[6789]|\s*$)/g)].map((match) => match[1]!);
  const grouped = source.match(/(?:^|[^\d])((?:[6789][\s,，、/|]+){5}[6789])(?![\d])/);
  let lineValues: number[] | null = null;
  if (grouped) {
    lineValues = grouped[1]!.match(/[6789]/g)!.map((char) => Number.parseInt(char, 10));
  } else if (separated.length === 6) {
    lineValues = separated.map((char) => Number.parseInt(char, 10));
  } else {
    const run = source.match(/(?<!\d)([6789]{6})(?!\d)/);
    if (run) {
      ambiguities.push(`出现连续六位数字「${run[1]}」，无法确定是否为爻值或爻序，需用户确认`);
    } else if (separated.length > 0) {
      ambiguities.push(`只识别到 ${separated.length} 个可能的爻值，需用户补齐为 6 个并确认顺序（初爻在前）`);
    }
  }

  // 时间：日期 + 钟点
  const dateMatch = source.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/);
  const timeMatch = source.match(/(\d{1,2})\s*[:：时点]\s*(\d{1,2})?/);
  let castAt: string | null = null;
  if (dateMatch) {
    const [, year, month, day] = dateMatch;
    if (timeMatch) {
      const hour = Number.parseInt(timeMatch[1]!, 10);
      const minute = timeMatch[2] ? Number.parseInt(timeMatch[2], 10) : 0;
      castAt = `${year}-${String(Number.parseInt(month!, 10)).padStart(2, '0')}-${String(Number.parseInt(day!, 10)).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
    } else {
      ambiguities.push('只识别到日期、没有具体钟点，无法确定起卦时刻');
    }
  } else if (timeMatch) {
    ambiguities.push('只识别到钟点、没有日期，无法确定起卦时刻');
  }

  // 时区：必须显式
  const timezoneMatch = source.match(/(Asia\/Shanghai|北京时间|中国标准时间|UTC\+8)/);
  const timezone = timezoneMatch ? 'Asia/Shanghai' : null;

  const missing: MissingInput[] = [];
  if (!lineValues) missing.push('lineValues');
  if (!castAt) missing.push('castTime');
  if (!timezone) missing.push('timezone');

  return { lineValues, castAt, timezone, ambiguities, missing };
}

export { SUPPORTED_TIMEZONES, SUPPORTED_RANGE };
