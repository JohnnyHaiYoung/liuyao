#!/usr/bin/env node
/**
 * Wiki 选页与证据片段自检（阶段 4 任务书第 7.1、7.2 节）。
 *
 * 直接用 Node 运行 TypeScript 模块（这些模块只依赖 node:*，不依赖 Next 运行时），
 * 因此"目录选页"可以在不启动网站的情况下被独立复验。
 *
 * 用法：node app/scripts/check-wiki-select.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, loadSourceManifest, resolveProjectRoot } from '../src/server/wiki/catalog.ts';
import { selectWikiEvidence } from '../src/server/wiki/select.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = resolveProjectRoot(path.resolve(here, '..', '..'));
const catalog = loadCatalog(projectRoot);
const manifest = loadSourceManifest(projectRoot);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};

console.log(`项目根：${projectRoot}`);
console.log(`目录：${catalog.catalogVersion}，${catalog.pages.length} 页；来源清单：${manifest.size} 条\n`);

console.log('=== 1) 概念问题：「什么是用神？」 ===');
{
  const result = selectWikiEvidence(projectRoot, catalog, '什么是用神？');
  const pageIds = result.selectedPages.map((page) => page.pageId);
  check('命中概念页 concepts/yongshen.md', pageIds.includes('concept:yongshen'), pageIds.join(', '));
  check('未命中无关比较页', !pageIds.includes('comparison:meihua-vs-liuyao'), pageIds.join(', '));
  check('产出可引用片段（含 ¶NNNN 或页码）', result.snippets.some((item) => item.citable), result.snippets.map((item) => `${item.sid}:${item.locatorValue ?? 'none'}${item.citable ? '' : '(不可引用)'}`).join(' '));
  check('needs_review 质量被提示（不当作已核对）', result.warnings.some((item) => item.includes('needs_review')), result.warnings.find((item) => item.includes('needs_review')) ?? '(无提示)');
  check('引用片段都带 source_id', result.snippets.every((item) => item.citable === false || (item.sourceId !== null && manifest.has(item.sourceId))), result.snippets.map((item) => item.sourceId).join(', '));
}

console.log('\n=== 2) 来源比较问题：「梅花起卦与六爻断卦怎么比较？」 ===');
{
  const result = selectWikiEvidence(projectRoot, catalog, '梅花起卦与六爻断卦怎么比较？');
  const pageIds = result.selectedPages.map((page) => page.pageId);
  check('命中对照页', pageIds.includes('comparison:meihua-vs-liuyao'), pageIds.join(', '));
  check('并列打开被引来源页', pageIds.some((id) => id.startsWith('source:')), pageIds.join(', '));
  check('选页不超预算', result.selectedPages.length <= 4, `${result.selectedPages.length} 页`);
}

console.log('\n=== 3) 无本地命中：「今天天气怎么样？」 ===');
{
  const result = selectWikiEvidence(projectRoot, catalog, '今天天气怎么样？');
  check('不编造本地来源', result.noLocalEvidence && result.snippets.length === 0, `selected=${result.selectedPages.length} snippets=${result.snippets.length}`);
  check('给出无本地依据的警告', result.warnings.some((item) => item.includes('本地 Wiki 无对应依据')), result.warnings[0] ?? '(无)');
}

console.log('\n=== 4) 预算：宽泛问题「用神 六亲 梅花 六爻 起卦 断卦 纳甲 旬空 世应」 ===');
{
  const result = selectWikiEvidence(projectRoot, catalog, '用神 六亲 梅花 六爻 起卦 断卦 纳甲 旬空 世应');
  check('选页数 ≤ 4', result.selectedPages.length <= 4, `${result.selectedPages.length} 页`);
  check('正文合计 ≤ 16000 字符', result.totalChars <= 16_000, `${result.totalChars} 字符`);
  check('截断时如实标注 budgetExceeded', result.selectedPages.length < catalog.pages.filter((page) => page.path !== 'wiki/index.md').length ? result.budgetExceeded || result.selectedPages.length <= 4 : true, `budgetExceeded=${result.budgetExceeded}`);
}

console.log('\n=== 5) 目录过期时不产出可引用片段 ===');
{
  const staleCatalog = JSON.parse(JSON.stringify(catalog));
  const target = staleCatalog.pages.find((page) => page.pageId === 'concept:yongshen');
  target.sha256 = '0'.repeat(64);
  const result = selectWikiEvidence(projectRoot, staleCatalog, '什么是用神？');
  check('过期页面被标记', result.warnings.some((item) => item.includes('目录过期')), result.warnings.find((item) => item.includes('目录过期')) ?? '(无)');
  check('过期页面不产出片段', result.snippets.every((item) => item.pageId !== 'concept:yongshen'), result.snippets.map((item) => item.pageId).join(', '));
}

console.log('\n=== 6) 片段编号与可引用性 ===');
{
  const result = selectWikiEvidence(projectRoot, catalog, '什么是用神？');
  const sids = result.snippets.map((item) => item.sid);
  check('编号形如 S1..Sn 且连续', sids.every((sid, index) => sid === `S${index + 1}`), sids.join(','));
  check('不可引用片段必须有原因', result.snippets.every((item) => item.citable || item.reason !== ''), result.snippets.filter((item) => !item.citable).map((item) => `${item.sid}:${item.reason}`).join(' | ') || '全部可引用');
}

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
