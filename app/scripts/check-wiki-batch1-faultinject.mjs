// 复验 P1-2 故障注入回归：来源数据链未就绪时不得产出可引用编号，恢复后正常。
// 对 src-777319b69476 的原件/清洗文本做临时故障（缺失/篡改），用完后立即恢复。
import { existsSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectRoot, loadCatalog } from '../src/server/wiki/catalog.ts';
import { selectWikiEvidence } from '../src/server/wiki/select.ts';
import { describeWikiCoverage } from '../src/server/wiki/coverage.ts';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  [通过] ${name}`); }
  else { fail += 1; console.log(`  [不通过] ${name}：${detail}`); }
}

const root = resolveProjectRoot();
const catalog = loadCatalog(root);
const sid = 'src-777319b69476';
const original = join(root, 'corpus/originals/五行所属行业/六神临六亲取象.txt');
const cleaned = join(root, 'corpus/cleaned/src-777319b69476.md');
const backup = original + '.faultbak';
const cleanedBak = cleaned + '.faultbak';
const Q = '六神是什么？';

const hasCitable = (snippets) => snippets.some((s) => s.sourceId === sid && s.citable);

// 基线
let r = selectWikiEvidence(root, catalog, Q);
check('基线：src-777319b69476 可引用', hasCitable(r.snippets), '');

// 1) 缺原件
if (existsSync(backup)) renameSync(backup, original); // 清理上次残留
renameSync(original, backup);
try {
  r = selectWikiEvidence(root, catalog, Q);
  check('缺原件 → 该来源不可引用', !hasCitable(r.snippets), '');
  const cov = describeWikiCoverage(root);
  check('缺原件 → imported=false', cov.files.find((f) => f.sourceId === sid)?.imported === false, '');
} finally {
  renameSync(backup, original);
}

// 2) 篡改原件
const origBytes = readFileSync(original);
writeFileSync(original, Buffer.from('tampered-tampered'));
try {
  r = selectWikiEvidence(root, catalog, Q);
  check('篡改原件 → 该来源不可引用', !hasCitable(r.snippets), '');
} finally {
  writeFileSync(original, origBytes);
}

// 3) 缺清洗文件
renameSync(cleaned, cleanedBak);
try {
  r = selectWikiEvidence(root, catalog, Q);
  check('缺清洗文件 → 该来源不可引用', !hasCitable(r.snippets), '');
} finally {
  renameSync(cleanedBak, cleaned);
}

// 恢复后正常
r = selectWikiEvidence(root, catalog, Q);
check('恢复后 → 该来源重新可引用', hasCitable(r.snippets), '');

console.log(`\n合计：${pass}/${pass + fail} 通过，${fail} 项不通过`);
process.exit(fail === 0 ? 0 : 1);
