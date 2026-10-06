/**
 * 排盘模块的公开入口（阶段 3 核心，阶段 4 由服务端适配层调用）。
 *
 * 供 `app/` 通过 `liuyao-paipan` 包名使用（app/package.json 里是 file: 依赖 + Next transpilePackages），
 * 也供离线自检脚本直接 `import` 使用：两种用法都是这一份源码，不存在"另抄一遍"的实现。
 */
export {
  buildChart,
  canonicalize,
  SCHEMA_VERSION,
  CORE_VERSION,
  type BuildOptions,
  type ChartLine,
  type ChartResult,
} from './core.ts';
export {
  PaipanError,
  fromMoment,
  fromManual,
  isSexagenary,
  sexagenaryCycle,
  parseStrictLocalTime,
  assertTimezone,
  SUPPORTED_TIMEZONES,
  SUPPORTED_RANGE,
  type AutoCalendarInput,
  type CalendarContext,
  type CalendarMode,
  type DayBoundary,
  type SolarTermWindow,
} from './calendar.ts';
export {
  TRIGRAMS,
  BRANCH_ELEMENT,
  GENERATES,
  CONTROLS,
  SIX_SPIRITS,
  sixRelative,
  spiritStartIndex,
  voidBranches,
  hexagramOf,
  loadRuleProfile,
  moduleRoot,
  projectRoot,
  type RuleProfile,
  type TrigramInfo,
} from './rules.ts';
