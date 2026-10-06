// 三方逐字段对照：自研核心 vs liuyao-skills(JS) vs fortune-liuyao-skill(Python)
//
// 复验报告（043eaf5）P1-2 要求：若把本命令作为"逐字段一致"证据，就必须真的逐字段比较，
// 并在发现差异时非零退出；否则只能作为人工对照材料。本脚本做前者：
//   · 字段归一按**固定上游的实际结构**（JS 的六亲在 current.text 内，如「父母丙寅木」）；
//   · Python 侧强制 UTF-8 输出；
//   · 任一侧解析失败、关键字段缺失或三方不一致 → 退出码 1，并逐条列出。
//
// 用法：
//   node paipan/scripts/upstream-compare.mjs
//   node paipan/scripts/upstream-compare.mjs 7 7 9 6 6 7 戊戌 亥     # 自定义爻值/日柱/月建
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChart, canonicalize } from '../src/core.ts';
import { fromManual } from '../src/calendar.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const SIX_RELATIVES = ['父母', '兄弟', '子孙', '妻财', '官鬼'];
// 术语变体（同一个东西的异体字，不是规则差异）：本项目按阶段 2 原页用字取「螣蛇」，
// fortune-liuyao-skill 写作「腾蛇」。归一后比较规则取值，变体单独记录。
const SPIRIT_VARIANTS = { 腾蛇: '螣蛇' };
const normalizeSpirit = (value) => (value === null || value === undefined ? null : SPIRIT_VARIANTS[value] ?? value);
const variants = [];
const noteVariant = (label, position, mineValue, otherValue) => {
  if (mineValue !== otherValue && normalizeSpirit(otherValue) === mineValue) {
    variants.push(`${label} 第${position}爻 六神：本项目「${mineValue}」/ 上游「${otherValue}」（异体字，已归一）`);
  }
};
const NORMALIZE_YINYANG = (value) => (value === true || value === 'yang' || value === '阳' ? 'yang' : value === false || value === 'yin' || value === '阴' ? 'yin' : null);

const argv = process.argv.slice(2);
const inputs = argv.length >= 8
  ? [{ lines: argv.slice(0, 6).map(Number), day: argv[6], month: argv[7] }]
  : [
      { lines: [8, 7, 8, 8, 8, 7], day: '戊辰', month: '申' },
      { lines: [7, 7, 9, 6, 6, 7], day: '戊戌', month: '亥' },
    ];

const problems = [];
const diffs = [];

const pick = (source, names) => {
  for (const name of names) {
    const value = source?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

/** 从「父母丙寅木」这类文本里拆出六亲与纳甲。 */
const parseNajiaText = (text) => {
  const value = String(text ?? '');
  const relative = SIX_RELATIVES.find((item) => value.startsWith(item)) ?? null;
  const rest = relative ? value.slice(relative.length) : value;
  const match = /^([甲乙丙丁戊己庚辛壬癸])([子丑寅卯辰巳午未申酉戌亥])([金木水火土])?$/.exec(rest);
  if (!match) return { relative, najia: null };
  return { relative, najia: `${match[1]}${match[2]}${match[3] ?? ''}` };
};

function runJs(lines, day, month) {
  const cli = path.join(repo, 'storage', 'repos', 'liuyao-skills', 'liuyao-paipan-code', 'scripts', 'paipan.mjs');
  const result = spawnSync('node', [cli, '--lines', ...lines.map(String), '--day', day, '--month', month], { encoding: 'utf8', windowsHide: true });
  const text = (result.stdout ?? '').replace(/^\uFEFF/, '');
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    const rows = new Map();
    for (const row of parsed.rows ?? []) {
      const current = row.current ?? row;
      const { relative, najia } = parseNajiaText(pick(current, ['text', 'najiaText']));
      const position = Number(pick(current, ['position']) ?? row.lineNumber);
      rows.set(position, {
        yinYang: NORMALIZE_YINYANG(pick(current, ['isYang', 'yinYang'])),
        najia,
        sixRelative: pick(current, ['sixRelative', 'relative']) ?? relative,
        sixSpirit: pick(row, ['spirit', 'sixSpirit']),
      });
    }
    return { rows, palace: parsed.palace?.name ?? null, voidBranches: parsed.calendar?.emptyBranches ?? null, raw: parsed };
  } catch (error) {
    problems.push(`liuyao-skills 输出无法解析：${error.message}`);
    return { rows: new Map(), palace: null, voidBranches: null, raw: null };
  }
}

function runPython(lines, day, month) {
  const scripts = path.join(repo, 'storage', 'repos', 'fortune-liuyao-skill', 'scripts');
  const code = [
    'import json,sys',
    `sys.path.insert(0, r'${scripts}')`,
    "sys.path.insert(0, r'" + path.join(repo, 'storage', 'repos', 'fortune-liuyao-skill', 'vendor') + "')",
    'from liuyao_core import build_chart',
    `chart = build_chart(${JSON.stringify(lines)}, day_ganzhi=${JSON.stringify(day)}, month_branch=${JSON.stringify(month)}, cast_at='2026-08-04T11:17:00+08:00')`,
    "print(json.dumps(chart, ensure_ascii=False))",
  ].join('\n');
  const result = spawnSync('E:\\python\\Python312\\python.exe', ['-c', code], {
    encoding: 'utf8',
    windowsHide: true,
    cwd: scripts,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  try {
    const parsed = JSON.parse((result.stdout ?? '').replace(/^\uFEFF/, ''));
    const chart = parsed.chart ?? parsed;
    const rows = new Map();
    for (const line of chart.lines ?? []) {
      rows.set(Number(line.position), {
        yinYang: NORMALIZE_YINYANG(line.yinYang),
        najia: `${line.najiaStem ?? ''}${line.najiaBranch ?? ''}${line.najiaElement ?? ''}`,
        sixRelative: line.sixRelative ?? null,
        sixSpirit: line.sixSpirit ?? null,
      });
    }
    return { rows, palace: chart.palaceElement ? `${chart.palace}(${chart.palaceElement})` : chart.palace ?? null, voidBranches: (chart.voidBranches ?? []).join(''), raw: chart };
  } catch (error) {
    problems.push(`fortune Python 输出无法解析：${error.message}｜stderr: ${(result.stderr ?? '').slice(0, 160)}`);
    return { rows: new Map(), palace: null, voidBranches: null, raw: null };
  }
}

const sortBranches = (value) => (typeof value === 'string' ? [...value].sort().join('') : null);
/** 卦宫名归一：Python 侧带五行后缀（如「离(火)」），统一取宫名。 */
const palaceName = (value) => (typeof value === 'string' ? value.replace(/\(.*\)$/, '').replace(/宫$/, '').trim() : null);

for (const { lines, day, month } of inputs) {
  const label = `[${lines.join(' ')}] ${day}日 ${month}月`;
  console.log(`\n########## 输入：${label} ##########`);
  const mine = canonicalize(buildChart(lines, fromManual(day, month)));
  const js = runJs(lines, day, month);
  const py = runPython(lines, day, month);

  const myRows = new Map(mine.lines.map((line) => [line.position, {
    yinYang: line.yinYang,
    najia: `${line.najia.stem}${line.najia.branch}${line.najia.element}`,
    sixRelative: line.sixRelative,
    sixSpirit: line.sixSpirit,
  }]));

  const same = (a, b) => a !== null && b !== null && a === b;
  console.log(`  我方：${mine.chart.original.name} → ${mine.chart.changed?.name ?? '（无变卦）'}；宫 ${mine.chart.palace.name}(${mine.chart.palace.element}) ${mine.chart.palace.stage}；世${mine.chart.shiPosition}应${mine.chart.yingPosition}；旬空 ${(mine.chart.voidBranches ?? []).join('')}`);
  console.log(`  JS  ：宫 ${js.palace ?? '(缺)'}；旬空 ${js.voidBranches ?? '(缺)'}`);
  console.log(`  PY  ：宫 ${py.palace ?? '(缺)'}；旬空 ${py.voidBranches ?? '(缺)'}`);

  const pairs = [
    ['旬空', sortBranches((mine.chart.voidBranches ?? []).join('')), sortBranches(js.voidBranches), sortBranches(py.voidBranches)],
    // 勘误 1（第三阶段最终验收）：卦宫此前只打印、未机器比较，这里补上自动比较。
    ['卦宫', palaceName(mine.chart.palace.name), palaceName(js.palace), palaceName(py.palace)],
  ];
  for (const [name, mineValue, jsValue, pyValue] of pairs) {
    const okJs = same(mineValue, jsValue);
    const okPy = same(mineValue, pyValue);
    console.log(`  ${name}：我方=${mineValue ?? '(缺)'} JS=${jsValue ?? '(缺)'}${okJs ? ' ✓' : ' ✗'} PY=${pyValue ?? '(缺)'}${okPy ? ' ✓' : ' ✗'}`);
    if (!okJs) diffs.push(`${label} ${name}：我方 ${mineValue} ≠ JS ${jsValue}`);
    if (!okPy) diffs.push(`${label} ${name}：我方 ${mineValue} ≠ PY ${pyValue}`);
  }

  for (const position of [6, 5, 4, 3, 2, 1]) {
    const mineRow = myRows.get(position);
    const jsRow = js.rows.get(position);
    const pyRow = py.rows.get(position);
    if (!jsRow) problems.push(`${label} JS 缺少第 ${position} 爻`);
    if (!pyRow) problems.push(`${label} PY 缺少第 ${position} 爻`);
    for (const field of ['yinYang', 'najia', 'sixRelative', 'sixSpirit']) {
      const mineValue = mineRow?.[field] ?? null;
      const jsValue = jsRow?.[field] ?? null;
      const pyValue = pyRow?.[field] ?? null;
      if (jsValue === null) problems.push(`${label} JS 第 ${position} 爻缺少 ${field}`);
      if (pyValue === null) problems.push(`${label} PY 第 ${position} 爻缺少 ${field}`);
      if (field === 'sixSpirit') {
        noteVariant(label, position, mineValue, jsValue);
        noteVariant(label, position, mineValue, pyValue);
      }
      const normalizedJs = field === 'sixSpirit' ? normalizeSpirit(jsValue) : jsValue;
      const normalizedPy = field === 'sixSpirit' ? normalizeSpirit(pyValue) : pyValue;
      if (!same(mineValue, normalizedJs)) diffs.push(`${label} 第${position}爻 ${field}：我方 ${mineValue} ≠ JS ${jsValue}`);
      if (!same(mineValue, normalizedPy)) diffs.push(`${label} 第${position}爻 ${field}：我方 ${mineValue} ≠ PY ${pyValue}`);
    }
    console.log(
      `  ${position}爻 我方 ${mineRow?.yinYang}/${mineRow?.najia}/${mineRow?.sixRelative}/${mineRow?.sixSpirit}` +
        ` | JS ${jsRow?.yinYang ?? '(缺)'}/${jsRow?.najia ?? '(缺)'}/${jsRow?.sixRelative ?? '(缺)'}/${jsRow?.sixSpirit ?? '(缺)'}` +
        ` | PY ${pyRow?.yinYang ?? '(缺)'}/${pyRow?.najia ?? '(缺)'}/${pyRow?.sixRelative ?? '(缺)'}/${pyRow?.sixSpirit ?? '(缺)'}`,
    );
  }
}

console.log('\n=== 汇总 ===');
console.log(`  逐字段不一致：${diffs.length} 条`);
for (const item of diffs.slice(0, 20)) console.log('    ' + item);
console.log(`  解析/字段缺失问题：${problems.length} 条`);
for (const item of problems.slice(0, 12)) console.log('    ' + item);
console.log(`  术语变体（已归一，不计为差异）：${variants.length} 条`);
for (const item of [...new Set(variants)].slice(0, 6)) console.log('    ' + item);
if (diffs.length === 0 && problems.length === 0) {
  console.log('  三方在阴阳/纳甲/六亲/六神/旬空/卦宫上逐字段一致（仍不等于传统规则正确）。');
  process.exitCode = 0;
} else {
  console.log('  对照未通过：不得据此声称逐字段一致。');
  process.exitCode = 1;
}
