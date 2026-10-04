// 上游两套实现的同输入对照（阶段 3，开发期工具）
// 输入：山水蒙，初爻在上顺序 [8,7,8,8,8,7]（阴 阳 阴 阴 阴 阳），日柱 戊辰、月建 申
// 目的：① 取证据核对纳甲/六亲/世应（不凭记忆写规则表）；② 产出两家差异表
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const lines = [8, 7, 8, 8, 8, 7];
const dayGanzhi = '戊辰';
const monthBranch = '申';

// --- A) liuyao-skills（纯 JS 核心，经其 CLI 装配层） ---
const jsCli = path.join(repo, 'storage', 'repos', 'liuyao-skills', 'liuyao-paipan-code', 'scripts', 'paipan.mjs');
const jsRun = spawnSync('node', [jsCli, '--lines', ...lines.map(String), '--day', dayGanzhi, '--month', monthBranch], {
  encoding: 'utf8',
  windowsHide: true,
});
let js = null;
try {
  js = JSON.parse(jsRun.stdout.slice(jsRun.stdout.indexOf('{')));
} catch (error) {
  console.error('liuyao-skills 输出解析失败：', error.message, jsRun.stdout?.slice(0, 200), jsRun.stderr?.slice(0, 200));
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
const pyRun = spawnSync('E:\\python\\Python312\\python.exe', ['-c', pyCode], { encoding: 'utf8', windowsHide: true, cwd: pyScripts });
let py = null;
try {
  py = JSON.parse(pyRun.stdout);
} catch (error) {
  console.error('fortune Python 输出解析失败：', error.message, (pyRun.stderr ?? '').slice(0, 300));
}

const compact = (row) => {
  const c = row.current ?? row;
  const changed = row.changeded ?? row.changedLine ?? row.changed ?? null;
  return {
    pos: c.position ?? row.position,
    yinYang: c.yinYang ?? row.yinYang,
    najia: c.najiaStem !== undefined ? `${c.najiaStem}${c.najiaBranch}${c.najiaElement}` : (c.text ?? ''),
    sixRelative: c.sixRelative ?? '',
    spirit: row.spirit ?? c.sixSpirit ?? '',
    shi: c.isShi ?? row.isShi ?? null,
    ying: c.isYing ?? row.isYing ?? null,
    void: c.isVoid ?? row.isVoid ?? null,
    hidden: row.hidden ?? '',
    hiddenCandidate: row.hiddenCandidate ?? '',
    changed: changed ? `${changed.yinYang ?? ''}${changed.najiaStem ?? ''}${changed.najiaBranch ?? ''}${changed.sixRelative ?? ''}` : '',
  };
};

console.log('=== A) liuyao-skills（JS） ===');
if (js) {
  console.log(`  宫：${js.palace?.title ?? '?'}；旬空：${js.calendar?.emptyBranches ?? '(未给)'}；日界：${js.calendar?.dayBoundary ?? '(未给)'}`);
  const rows = (js.rows ?? []).slice().sort((a, b) => (b.lineNumber ?? 0) - (a.lineNumber ?? 0));
  for (const row of rows) {
    const c = compact(row);
    console.log(`  ${c.pos}爻 阴阳=${c.yinYang} 纳甲=${c.najia} 六亲=${c.sixRelative} 六神=${c.spirit}${c.shi ? ' 世' : ''}${c.ying ? ' 应' : ''}${c.void ? ' 空' : ''}${c.hidden ? ' 伏=' + c.hidden + '(' + c.hiddenCandidate + ')' : ''} 变=${c.changed}`);
  }
}

console.log('\n=== B) fortune-liuyao-skill（Python） ===');
if (py) {
  const chart = py.chart ?? py;
  console.log(`  宫：${chart.palace ?? '?'}(${chart.palaceStage ?? ''})；旬空：${JSON.stringify(chart.voidBranches ?? [])}；月建：${chart.monthBranch ?? '?'}`);
  const rows = (chart.lines ?? []).slice().sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
  for (const line of rows) {
    console.log(
      `  ${line.position}爻 阴阳=${line.yinYang} 纳甲=${line.najiaStem}${line.najiaBranch}${line.najiaElement} 六亲=${line.sixRelative} 六神=${line.sixSpirit}${line.isShi ? ' 世' : ''}${line.isYing ? ' 应' : ''}${line.isVoid ? ' 空' : ''} 变=${line.changedLine ? `${line.changedLine.yinYang}${line.changedLine.najiaStem}${line.changedLine.najiaBranch}${line.changedLine.sixRelative}` : ''}`,
    );
  }
  for (const hidden of chart.hiddenLines ?? []) {
    console.log(`  伏神 ${hidden.position}爻 ${hidden.najiaStem}${hidden.najiaBranch}${hidden.najiaElement} ${hidden.sixRelative}（飞神 ${hidden.flyingStem}${hidden.flyingBranch}${hidden.flyingElement} ${hidden.flyingSixRelative}）`);
  }
}
console.log('\n=== C) 阶段 2 原页（corpus/figures/src-e6fc8612e955/page-003.md，人工目视） ===');
console.log('  离宫 山水蒙：上九=父母寅木、六五=官鬼子水、六四=妻财酉金(世)、六三=兄弟午火、九二=子孙辰土、初六=父母寅木(应)');
