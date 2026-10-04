// 64 卦名全量核对（阶段 3，开发期工具）
// 自研卦名表 vs ① liuyao-skills 的 GUA_CODE_TABLE（code 为自下而上 9=阳/6=阴）
//                ② fortune-liuyao-skill 的 _hexagram(tuple(bits))，1=阳/0=阴
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hexagramOf } from '../src/rules.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const codeOf = (bits) => bits.join('');

// ① 自研
const mine = new Map();
for (let mask = 0; mask < 64; mask += 1) {
  const bits = [0, 1, 2, 3, 4, 5].map((index) => (mask >> index) & 1);
  mine.set(codeOf(bits), hexagramOf(bits).name);
}

// ② liuyao-skills：code '966696' → bits（自下而上，9→阳）
const jsNames = new Map();
const data = await import(
  pathToFileURL(path.join(repo, 'storage', 'repos', 'liuyao-skills', 'liuyao-paipan-code', 'src', 'data', 'hexagrams.js')).href
);
for (const entry of Object.values(data.GUA_CODE_TABLE ?? {})) {
  const code = entry?.code;
  if (typeof code !== 'string' || code.length !== 6) continue;
  const bits = [...code].map((char) => (char === '9' ? 1 : 0));
  jsNames.set(codeOf(bits), entry.name);
}
console.log(`liuyao-skills：解析出 ${jsNames.size} 个卦名；示例 ${[...jsNames.entries()].slice(0, 3).map(([k, v]) => `${k}=${v}`).join('，')}`);

// ③ fortune-liuyao-skill：一次进程内输出 64 个
const pyScripts = path.join(repo, 'storage', 'repos', 'fortune-liuyao-skill', 'scripts');
const pyCode = [
  'import json,sys',
  `sys.path.insert(0, r'${pyScripts}')`,
  "sys.path.insert(0, r'" + path.join(repo, 'storage', 'repos', 'fortune-liuyao-skill', 'vendor') + "')",
  'import liuyao_core as lc',
  'out = {}',
  'for mask in range(64):',
  '    bits = tuple((mask >> i) & 1 for i in range(6))',
  '    r = lc._hexagram(bits)',
  '    if isinstance(r, dict):',
  '        name = r.get("name")',
  '    elif isinstance(r, (list, tuple)):',
  '        name = r[0]',
  '    else:',
  '        name = str(r)',
  '    out["".join(str(b) for b in bits)] = name',
  'print(json.dumps(out, ensure_ascii=False))',
].join('\n');
const pyRun = spawnSync('E:\\python\\Python312\\python.exe', ['-c', pyCode], {
  encoding: 'utf8',
  windowsHide: true,
  cwd: pyScripts,
  // 必须显式要求 UTF-8 输出，否则 Python 用本地编码（GBK）写 stdout，读回来就是乱码
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
let pyNames = new Map();
try {
  pyNames = new Map(Object.entries(JSON.parse(pyRun.stdout)));
  console.log(`fortune：解析出 ${pyNames.size} 个卦名；示例 ${[...pyNames.entries()].slice(0, 3).map(([k, v]) => `${k}=${v}`).join('，')}`);
} catch (error) {
  console.log(`fortune 解析失败：${error.message}｜stderr: ${(pyRun.stderr ?? '').slice(0, 200)}`);
}

const mismatchJs = [];
const mismatchPy = [];
// 命名粒度不同：自研用全名（地火明夷 / 水雷屯 / 天泽履），上游用短名（明夷 / 屯 / 履）。
// 规则：纯卦形如「乾为天」→ 取首字；其余形如「地火明夷」→ 去掉上下卦象两字。
const shortName = (full) => (full.includes('为') ? full.slice(0, 1) : full.slice(2));
for (const [bits, name] of mine) {
  const mineShort = shortName(name);
  const js = jsNames.get(bits);
  const py = pyNames.get(bits);
  // JS 表用短名；Python 表用全名（两者都在脚本内归一化后再比）
  if (js && js !== mineShort) mismatchJs.push(`${bits}: 自研 ${name}(${mineShort}) / JS ${js}`);
  if (py && py !== name && py !== mineShort) mismatchPy.push(`${bits}: 自研 ${name}(${mineShort}) / Python ${py}`);
}
console.log(`\n与 liuyao-skills 比对（覆盖 ${[...mine.keys()].filter((k) => jsNames.has(k)).length}/64）：不一致 ${mismatchJs.length} 项`);
for (const item of mismatchJs) console.log('  ' + item);
console.log(`与 fortune 比对（覆盖 ${[...mine.keys()].filter((k) => pyNames.has(k)).length}/64）：不一致 ${mismatchPy.length} 项`);
for (const item of mismatchPy) console.log('  ' + item);
process.exitCode = mismatchJs.length === 0 && mismatchPy.length === 0 && jsNames.size === 64 && pyNames.size === 64 ? 0 : 1;
