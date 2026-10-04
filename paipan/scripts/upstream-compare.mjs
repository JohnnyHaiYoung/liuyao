// 上游两套实现的同输入对照（阶段 3，开发期工具）
//
// 验收报告（7a6ab8d）证据项 4 的修复：字段映射按两侧真实结构提取、Python 强制 UTF-8、
// 解析失败或关键字段缺失时**非零退出**，避免"脚本退出成功"被当成逐字段一致证据。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const lines = process.argv.slice(2).length === 6 ? process.argv.slice(2).map(Number) : [8, 7, 8, 8, 8, 7];
const dayGanzhi = '戊辰';
const monthBranch = '申';
const problems = [];

// --- A) liuyao-skills（纯 JS 核心，经其 CLI 装配层） ---
const jsCli = path.join(repo, 'storage', 'repos', 'liuyao-skills', 'liuyao-paipan-code', 'scripts', 'paipan.mjs');
const jsRun = spawnSync('node', [jsCli, '--lines', ...lines.map(String), '--day', dayGanzhi, '--month', monthBranch], {
  encoding: 'utf8',
  windowsHide: true,
});
const jsText = (jsRun.stdout ?? '').replace(/^\uFEFF/, '');
let js = null;
try {
  js = JSON.parse(jsText.slice(jsText.indexOf('{')));
} catch (error) {
  problems.push(`liuyao-skills 输出无法解析：${error.message}`);
}

/** 从一行里按候选字段名取值；两侧命名不同，统一在这里归一。 */
const pick = (source, names) => {
  for (const name of names) {
    const value = source?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

const jsRows = [];
if (js) {
  for (const row of (js.rows ?? []).slice().sort((a, b) => (b.lineNumber ?? 0) - (a.lineNumber ?? 0))) {
    const current = row.current ?? row;
    const najiaText = pick(current, ['text', 'najiaText']) ?? '';
    const isYang = pick(current, ['isYang']);
    const yinYang = isYang === null ? pick(current, ['yinYang']) : isYang ? 'yang' : 'yin';
    jsRows.push({
      position: pick(current, ['position']) ?? row.lineNumber,
      yinYang,
      najiaText,
      sixRelative: pick(current, ['sixRelative', 'relative', 'sixQin']),
      sixSpirit: pick(row, ['spirit', 'sixSpirit']),
      hidden: pick(row, ['hidden', 'hiddenCandidate']),
    });
  }
  if (jsRows.some((row) => row.yinYang === null)) problems.push('liuyao-skills 行缺少阴阳字段（字段名可能又是新的）');
  if (jsRows.some((row) => !row.sixRelative)) problems.push('liuyao-skills 行缺少六亲字段（JS 侧六亲可能在 text 内）');
}

// --- B) fortune-liuyao-skill（Python 核心，只读调用，显式不写盘） ---
const pyScripts = path.join(repo, 'storage', 'repos', 'fortune-liuyao-skill', 'scripts');
const pyCode = [
  'import json,sys',
  `sys.path.insert(0, r'${pyScripts}')`,
  "sys.path.insert(0, r'" + path.join(repo, 'storage', 'repos', 'fortune-liuyao-skill', 'vendor') + "')",
  'from liuyao_core import build_chart',
  `chart = build_chart(${JSON.stringify(lines)}, day_ganzhi=${JSON.stringify(dayGanzhi)}, month_branch=${JSON.stringify(monthBranch)}, cast_at='2026-08-04T11:17:00+08:00')`,
  "print(json.dumps(chart, ensure_ascii=False))",
].join('\n');
const pyRun = spawnSync('E:\\python\\Python312\\python.exe', ['-c', pyCode], {
  encoding: 'utf8',
  windowsHide: true,
  cwd: pyScripts,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, // 不加会在本地编码下变成乱码
});
const pyText = (pyRun.stdout ?? '').replace(/^\uFEFF/, '');
let py = null;
try {
  py = JSON.parse(pyText);
} catch (error) {
  problems.push(`fortune Python 输出无法解析：${error.message}｜stderr: ${(pyRun.stderr ?? '').slice(0, 160)}`);
}

console.log(`输入：初爻在前 [${lines.join(' ')}]，日柱 ${dayGanzhi}，月建 ${monthBranch}`);
console.log('\n=== A) liuyao-skills（JS） ===');
for (const row of jsRows) {
  console.log(
    `  ${row.position}爻 阴阳=${row.yinYang ?? '(缺)'} 纳甲=${row.najiaText || '(缺)'} 六亲=${row.sixRelative ?? '(缺)'}` +
      ` 六神=${row.sixSpirit ?? '(缺)'}${row.hidden ? ' 伏=' + row.hidden : ''}`,
  );
}

console.log('\n=== B) fortune-liuyao-skill（Python） ===');
if (py) {
  const chart = py.chart ?? py;
  console.log(`  宫：${chart.palace ?? '?'}(${chart.palaceStage ?? ''})；旬空：${JSON.stringify(chart.voidBranches ?? [])}；月建：${chart.monthBranch ?? '?'}`);
  for (const line of (chart.lines ?? []).slice().sort((a, b) => (b.position ?? 0) - (a.position ?? 0))) {
    console.log(
      `  ${line.position}爻 阴阳=${line.yinYang ?? '(缺)'} 纳甲=${line.najiaStem ?? ''}${line.najiaBranch ?? ''}${line.najiaElement ?? ''}` +
        ` 六亲=${line.sixRelative ?? '(缺)'} 六神=${line.sixSpirit ?? '(缺)'}${line.isShi ? ' 世' : ''}${line.isYing ? ' 应' : ''}${line.isVoid ? ' 空' : ''}`,
    );
  }
}

console.log('\n=== C) 阶段 2 原页（corpus/figures/src-e6fc8612e955/page-003.md，人工目视） ===');
console.log('  离宫 山水蒙：上=父母寅木、五=官鬼子水、四=妻财酉金/子孙戌土(世)、三=兄弟午火、二=子孙辰土、初=父母寅木(应)');

if (problems.length > 0) {
  console.error('\n对照未完成（不得据此声称逐字段一致）：');
  for (const item of problems) console.error(`  - ${item}`);
  process.exitCode = 1;
} else {
  console.log('\n两侧输出均解析成功、关键字段齐全；逐字段一致性需按上表人工比对（本脚本只做映射与呈现）。');
}
