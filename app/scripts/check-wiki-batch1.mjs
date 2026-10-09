// 第一批 Wiki 扩充自测：收录范围四层 + 新词目录选页命中 + 来源页可读。
// 运行：node --import ./app/scripts/lib/register-ts.mjs app/scripts/check-wiki-batch1.mjs
import { resolveProjectRoot, loadCatalog, loadSourceManifest, readCatalogPage } from '../src/server/wiki/catalog.ts';
import { describeWikiCoverage, findCoverageFiles } from '../src/server/wiki/coverage.ts';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  [通过] ${name}`); }
  else { fail += 1; console.log(`  [不通过] ${name}：${detail}`); }
}

const root = resolveProjectRoot();
const catalog = loadCatalog(root);
const manifest = loadSourceManifest(root);

// 1) 收录范围四层：10 导入 / 10 提取 / 10 编入（阶段 2 六份 + 第一批四份）
const c = describeWikiCoverage(root);
check('已导入原件 = 10', c.counts.imported === 10, `${c.counts.imported}`);
check('已提取/清洗 = 10', c.counts.processed === 10, `${c.counts.processed}`);
check('已编入 Wiki = 10', c.counts.wikiIndexed === 10, `${c.counts.wikiIndexed}`);
check('四个新 source_id 均在 manifest', ['src-31cafa8c2634', 'src-777319b69476', 'src-fd45fbed3007', 'src-a76b03f471fe'].every((id) => manifest.has(id)));

// 2) 三层区分：文件查询命中正确的来源
const quyongshen = findCoverageFiles(root, '取用神');
check('查「取用神」命中 2 份（旧 + 新）', quyongshen.length === 2 && quyongshen.some((f) => f.sourceId === 'src-31cafa8c2634'), quyongshen.map((f) => f.sourceId).join(','));
const jifa = findCoverageFiles(root, '断卦技法');
check('查「断卦技法」命中 src-fd45fbed3007', jifa.length === 1 && jifa[0].sourceId === 'src-fd45fbed3007', jifa.map((f) => f.sourceId).join(','));
const texun = findCoverageFiles(root, '特训班');
check('查「特训班」命中 src-a76b03f471fe', texun.length === 1 && texun[0].sourceId === 'src-a76b03f471fe', texun.map((f) => f.sourceId).join(','));
const nothere = findCoverageFiles(root, '不存在书名XYZ');
check('查「不存在书名XYZ」返回空（不编造读过）', nothere.length === 0, nothere.map((f) => f.sourceId).join(','));

// 3) 新词目录选页命中
const byId = new Map(catalog.pages.map((p) => [p.pageId, p]));
const liushen = byId.get('concept:liushen-liuqin');
check('概念页「六神临六亲取象」在目录', Boolean(liushen), '');
check('六神取象别名可命中「六神是什么」', Boolean(liushen?.aliases?.includes('六神是什么')), liushen?.aliases?.join(','));
const duangua = byId.get('concept:duangua-jifa');
check('概念页「断卦技法」在目录', Boolean(duangua), '');
check('断卦技法别名可命中「断卦口诀」', Boolean(duangua?.aliases?.includes('断卦口诀')), duangua?.aliases?.join(','));
check('断卦技法概念页含来源 src-fd45fbed3007', Boolean(duangua?.sourceIds?.includes('src-fd45fbed3007')), duangua?.sourceIds?.join(','));

// 4) 来源页可读且含定位
const src31 = catalog.pages.find((p) => p.pageId === 'source:src-31cafa8c2634');
check('来源页 src-31cafa8c2634 可读且哈希一致', Boolean(src31 && readCatalogPage(root, src31).hashMatches), src31?.path ?? '');

console.log(`\n合计：${pass}/${pass + fail} 通过，${fail} 项不通过`);
process.exit(fail === 0 ? 0 : 1);
