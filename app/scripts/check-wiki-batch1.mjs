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

// 5) 收录问答路由（复验 P1-2）：五路区分，planTurn 级
const { planTurn, buildMissingInputReply } = await import('../src/server/chat/planner.ts');
function routeReply(q) {
  const r = planTurn({ question: q, projectRoot: root, catalog, promptVersion: 'phase4-v1' });
  return { kind: r.plan.clarificationKind ?? null, reply: buildMissingInputReply(r.plan) ?? '' };
}
const ov = routeReply('收录了什么？');
check('「收录了什么？」→ 目录总览', ov.kind === 'coverage' && ov.reply.includes('已导入原件'), ov.kind);
const cnt = routeReply('目前录入了多少份？');
check('「目前录入了多少份？」→ 分层数量', cnt.kind === 'coverage' && cnt.reply.includes('已核对可引用规则'), cnt.kind);
const cnt2 = routeReply('录入了哪些资料');
check('「录入了哪些资料」→ 目录总览', cnt2.kind === 'coverage', cnt2.kind);
const file = routeReply('有没有六爻断卦技法这本书');
check('「有没有六爻断卦技法这本书」→ 命中 src-fd45fbed3007', file.kind === 'coverage' && file.reply.includes('src-fd45fbed3007'), file.kind);
const topic = routeReply('有没有关于用神的资料？');
check('「有没有关于用神的资料？」→ 主题命中用神', topic.kind === 'coverage' && (topic.reply.includes('取用神') || topic.reply.includes('yongshen') || topic.reply.includes('src-08862b06aea9')), topic.reply.slice(0, 40));
const know = routeReply('六神里面有没有官鬼？');
check('「六神里面有没有官鬼？」→ 普通知识（不拦截）', know.kind === null, String(know.kind));
const thisTurn = routeReply('这次引用了什么？');
check('「这次引用了什么？」无上一答 → 明说无可用引用', thisTurn.kind === 'coverage' && thisTurn.reply.includes('无可用引用'), thisTurn.reply.slice(0, 40));
// 复验 P1-1：有上一答持久化引用快照时，列出快照（与 done.sourceIds 一致），不重新选页
const { planTurn: pt } = await import('../src/server/chat/planner.ts');
const withPrev = pt({
  question: '刚才那条回答引用了哪些来源？',
  projectRoot: root,
  catalog,
  promptVersion: 'phase4-v1',
  previousCitations: [
    { sid: 'S1', sourceId: 'src-777319b69476', locatorValue: '¶0002', qualityStatus: 'usable' },
    { sid: 'S3', sourceId: 'src-777319b69476', locatorValue: '¶0005', qualityStatus: 'usable' },
  ],
});
const withPrevReply = buildMissingInputReply(withPrev.plan) ?? '';
check('有上一答快照 → 列 S1/S3（src-777319b69476）且含质量', withPrevReply.includes('S1') && withPrevReply.includes('src-777319b69476') && withPrevReply.includes('usable'), withPrevReply.slice(0, 60));

// P2-1：具体文件问法新措辞
for (const filePhrase of ['有没有六爻断卦技法？', '收录六爻断卦技法了吗？', '你读过《六爻断卦技法》吗？']) {
  const f = routeReply(filePhrase);
  check(`「${filePhrase}」→ 文件命中 src-fd45fbed3007`, f.kind === 'coverage' && f.reply.includes('src-fd45fbed3007'), f.kind);
}
// P2-2：主题查询不含维护日志
const topic2 = routeReply('有没有关于用神的资料？');
check('主题查询不含「维护记录」', !topic2.reply.includes('维护记录'), '');

// P2-4：长讲义正文未核对标 needs_review；断卦技法卦例段不得当已核对规则
const txSrc = readCatalogPage(root, catalog.pages.find((p) => p.pageId === 'source:src-a76b03f471fe')).text;
check('讲义来源页标 needs_review 且明说正文未逐段核对', txSrc.includes('needs_review') && txSrc.includes('未逐段核对'), '');
const dgSrc = readCatalogPage(root, catalog.pages.find((p) => p.pageId === 'source:src-fd45fbed3007')).text;
check('断卦技法卦例段（¶0018–¶0028）标 needs_review、不得当已核对规则', dgSrc.includes('¶0018') && dgSrc.includes('needs_review') && (dgSrc.includes('不代表案例可核实') || dgSrc.includes('不得作为可验证案例')), '');

console.log(`\n合计：${pass}/${pass + fail} 通过，${fail} 项不通过`);
process.exit(fail === 0 ? 0 : 1);
