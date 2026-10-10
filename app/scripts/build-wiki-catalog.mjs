#!/usr/bin/env node
/**
 * 构建并校验 Wiki 机器可读目录 `wiki/catalog.json`（阶段 4 任务书第 3.1 节）。
 *
 * 设计原则：
 *   - 目录从 `wiki/index.md`（导航与来源质量表）+ 各页面正文**生成**，不手工散写；
 *   - 输出确定性：不写入生成时间戳，只有源页哈希与条目结构，使 `--check` 可用于漂移检测；
 *   - 只登记已存在的页面；缺页、哈希变化、索引链接未覆盖都会让 `--check` 非零退出。
 *
 * 用法：
 *   node app/scripts/build-wiki-catalog.mjs           # 生成/更新 wiki/catalog.json
 *   node app/scripts/build-wiki-catalog.mjs --check   # 仅校验是否与磁盘一致（CI/验收）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const wikiDir = path.join(projectRoot, 'wiki');
const indexPath = path.join(wikiDir, 'index.md');
const catalogPath = path.join(wikiDir, 'catalog.json');

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const read = (file) => fs.readFileSync(file, 'utf8');

/** 别名/主题补充：仅用于模型与用户都常见的说法，手工登记，避免自动猜测。 */
const ALIAS_SEED = {
  'concepts/yongshen.md': { aliases: ['取用神', '用神是什么', '用神怎么取', '如何取用神'], kind: 'concept' },
  'concepts/liushen-liuqin.md': { aliases: ['六神临六亲', '六神取象', '六神临六亲取象', '青龙朱雀勾陈螣蛇白虎玄武', '六神是什么'], kind: 'concept' },
  'concepts/duangua-jifa.md': { aliases: ['断卦技法', '断卦口诀', '怎么看空冲刑合', '断卦怎么断', '断卦技法口诀'], kind: 'concept' },
  'concepts/yaoxiang-yaowei.md': { aliases: ['爻象', '爻位', '爻位类象', '爻象怎么解释', '爻位怎么看家宅', '占家宅初爻'], kind: 'concept' },
  'comparisons/meihua-vs-liuyao.md': { aliases: ['梅花易数和六爻的区别', '梅花起卦与六爻断卦'], kind: 'comparison' },
  'schema.md': { aliases: ['Wiki 编写规则'], kind: 'schema' },
  'log.md': { aliases: ['维护记录'], kind: 'log' },
};

const indexText = read(indexPath);

/** 从 index.md 的来源表里取质量状态（人工维护的权威值）。 */
const qualityBySource = new Map();
for (const line of indexText.split(/\r?\n/)) {
  const match = /\|\s*\[(src-[0-9a-f]{12})\]\(sources\/(src-[0-9a-f]{12})\.md\)\s*\|[^|]*\|[^|]*\|\s*`(usable|needs_review)`/.exec(line);
  if (match) qualityBySource.set(match[1], match[3]);
}

/** 从 index.md 收集页面链接（阅读路径 + 来源表），这些是"目录声明"的页面。 */
const linked = new Map(); // 相对 wiki/ 的路径 -> 显示名
for (const match of indexText.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g)) {
  const target = match[2];
  if (/^[a-z]+:\/\//i.test(target) || target.startsWith('../')) continue; // 站外或指向包外
  const relative = path.posix.normalize(target);
  linked.set(relative, match[1]);
}

const pagePaths = [...linked.keys()].sort();
const pages = [];
const errors = [];
const statusRank = { usable: 0, needs_review: 1 };

for (const relative of pagePaths) {
  const absolute = path.join(wikiDir, relative);
  if (!fs.existsSync(absolute)) {
    errors.push(`index.md 链接的页面不存在：wiki/${relative}`);
    continue;
  }
  const text = read(absolute);
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? path.basename(relative, '.md');
  const topics = [...text.matchAll(/^##\s+(.+)$/gm)].map((item) => item[1].trim());
  const sourceIds = [...new Set([...text.matchAll(/src-[0-9a-f]{12}/g)].map((item) => item[0]))].sort();
  const isSourcePage = relative.startsWith('sources/');
  const sourceIdFromName = isSourcePage ? /(src-[0-9a-f]{12})/.exec(relative)?.[1] : undefined;
  const seed = ALIAS_SEED[relative] ?? {};
  const kind = seed.kind ?? (isSourcePage ? 'source' : 'page');

  let qualityStatus = 'usable';
  if (isSourcePage) {
    qualityStatus = qualityBySource.get(sourceIdFromName) ?? 'usable';
    if (!qualityBySource.has(sourceIdFromName)) errors.push(`index.md 未登记来源质量：${sourceIdFromName}`);
  } else {
    // 非来源页：取所引来源中最差的质量状态，避免把含 needs_review 证据的页面说成已核对。
    const cited = sourceIds.filter((id) => qualityBySource.has(id));
    qualityStatus = cited.some((id) => qualityBySource.get(id) === 'needs_review') ? 'needs_review' : 'usable';
  }

  pages.push({
    pageId: isSourcePage ? `source:${sourceIdFromName}` : `${kind}:${path.basename(relative, '.md')}`,
    path: `wiki/${relative}`,
    kind,
    title,
    displayName: linked.get(relative),
    topics,
    aliases: (seed.aliases ?? []).slice().sort(),
    methodLabels: [],
    sourceIds,
    qualityStatus,
    qualityRank: statusRank[qualityStatus] ?? 0,
    applicableQuestions: [],
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha256(text),
  });
}

const catalog = {
  catalogVersion: 'wiki-catalog.v1',
  generatedFrom: {
    indexPath: 'wiki/index.md',
    indexSha256: sha256(indexText),
    note: '由 app/scripts/build-wiki-catalog.mjs 生成；不写入时间戳以保证 --check 可做漂移检测',
  },
  pageCount: pages.length,
  pages,
};

if (errors.length > 0) {
  for (const item of errors) console.error(`错误：${item}`);
  process.exitCode = 1;
}

const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
const checkMode = process.argv.includes('--check');

if (checkMode) {
  if (!fs.existsSync(catalogPath)) {
    console.error('wiki/catalog.json 不存在；请先运行 node app/scripts/build-wiki-catalog.mjs');
    process.exit(1);
  }
  const existing = read(catalogPath);
  if (existing === serialized) {
    console.log(`目录一致：${catalog.pageCount} 页，条目与哈希均与 wiki/ 当前内容匹配。`);
    process.exit(process.exitCode ?? 0);
  }
  const existingJson = JSON.parse(existing);
  const existingByPath = new Map(existingJson.pages.map((page) => [page.path, page]));
  for (const page of pages) {
    const before = existingByPath.get(page.path);
    if (!before) console.error(`  目录缺少页面：${page.path}`);
    else if (before.sha256 !== page.sha256) console.error(`  页面哈希已变化，目录过期：${page.path}`);
    else if (JSON.stringify(before) !== JSON.stringify(page)) console.error(`  条目字段与生成结果不一致：${page.path}`);
  }
  for (const page of existingJson.pages ?? []) {
    if (!pages.some((item) => item.path === page.path)) console.error(`  目录含多余页面（index.md 未链接）：${page.path}`);
  }
  console.error('wiki/catalog.json 与 wiki/ 当前内容不一致；请重新生成并复核。');
  process.exit(1);
}

fs.writeFileSync(catalogPath, serialized, 'utf8');
console.log(`已生成 wiki/catalog.json：${catalog.pageCount} 页`);
for (const page of pages) {
  console.log(`  ${page.qualityStatus.padEnd(12)} ${page.path}  topics=${page.topics.length} sourceIds=${page.sourceIds.length} sha256=${page.sha256.slice(0, 12)}…`);
}
