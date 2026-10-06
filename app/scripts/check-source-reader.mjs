#!/usr/bin/env node
/**
 * 来源出处接口的安全与可达性自检（阶段 4 任务书第 3.6、7.2 节）。
 *
 * 断言的是**服务端模块**（路由只是薄封装），因此不需要启动 Next 即可复验：
 *   - 未知 source_id、越权路径、`..`、绝对路径、URL 编码、扩展名白名单、符号链接越界；
 *   - `¶NNNN` 段落定位与「第 N 页」页码定位能回到包内真实片段；
 *   - 页图只允许 `<sourceId>/page-NNN.jpg`，且返回真实存在的文件与 image/jpeg。
 *
 * 用法：node app/scripts/check-source-reader.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, resolveProjectRoot } from '../src/server/wiki/catalog.ts';
import { SourceAccessError, describeSource, readPage, readParagraph, resolveAsset } from '../src/server/wiki/source-reader.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = resolveProjectRoot(path.resolve(here, '..', '..'));
const catalog = loadCatalog(projectRoot);
const PDF_SOURCE = 'src-e6fc8612e955'; // 有页图与逐页转写
const SCAN_SOURCE = 'src-f3f838d501b1'; // 有页图、无逐页转写

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};
const expectError = (name, code, fn) => {
  try {
    fn();
    check(name, false, '未抛错（应拒绝）');
  } catch (error) {
    const actual = error instanceof SourceAccessError ? error.code : `非 SourceAccessError：${error?.constructor?.name}`;
    check(name, actual === code, `code=${actual}`);
  }
};

console.log(`项目根：${projectRoot}\n`);

console.log('=== 1) 正常读取（白名单内的来源） ===');
{
  const paragraph = readParagraph(projectRoot, PDF_SOURCE, '¶0002');
  check('¶0002 可读出正文', paragraph.text.trim().length > 0, `${paragraph.text.length} 字符，清洗文件 ${paragraph.cleanedPath}`);
  check('段落能给出 PDF 实际页码', paragraph.pageNumber !== null, `第 ${paragraph.pageNumber} 页`);
  check('返回清洗文件哈希（供历史快照）', /^[0-9a-f]{64}$/.test(paragraph.cleanedSha256), paragraph.cleanedSha256.slice(0, 12) + '…');
  const page = readPage(projectRoot, PDF_SOURCE, '第 3 页');
  check('页码定位给出页图', page.assetAvailable && page.assetPath === `corpus/assets/${PDF_SOURCE}/page-003.jpg`, String(page.assetPath));
  check('页码定位给出逐页转写（存在时）', page.transcriptionPath === `corpus/figures/${PDF_SOURCE}/page-003.md`, String(page.transcriptionPath));
  const scanPage = readPage(projectRoot, SCAN_SOURCE, 'page:2');
  check('英文 page:N 定位同样可用', scanPage.page === 2 && scanPage.assetAvailable, `第 ${scanPage.page} 页 asset=${scanPage.assetAvailable}`);
  const described = describeSource(projectRoot, PDF_SOURCE, catalog);
  check('来源元信息含质量与图片清单', described.qualityStatus === 'needs_review' && described.assets.length === 23, `quality=${described.qualityStatus} assets=${described.assets.length} paragraphs=${described.paragraphCount}`);
  const scanDescribed = describeSource(projectRoot, SCAN_SOURCE, catalog);
  check('扫描件页图数为 5 且无逐页转写', scanDescribed.assets.length === 5 && scanDescribed.transcriptions.length === 0, `assets=${scanDescribed.assets.length} transcriptions=${scanDescribed.transcriptions.length}`);
}

console.log('\n=== 2) 未知来源与非法 ID ===');
{
  expectError('未知 source_id 被拒', 'unknown_source', () => readParagraph(projectRoot, 'src-000000000000', '¶0001'));
  expectError('非 src- 形式 ID 被拒', 'invalid_source_id', () => readParagraph(projectRoot, 'manifest.jsonl', '¶0001'));
  expectError('路径式 ID 被拒', 'invalid_source_id', () => readParagraph(projectRoot, '../../corpus/manifest.jsonl', '¶0001'));
}

console.log('\n=== 3) 定位注入与越权路径 ===');
{
  expectError('段落定位必须是 ¶NNNN', 'invalid_locator', () => readParagraph(projectRoot, PDF_SOURCE, '¶12'));
  expectError('段落定位不接受路径', 'invalid_locator', () => readParagraph(projectRoot, PDF_SOURCE, '../../manifest.jsonl'));
  expectError('页码定位越界被拒', 'invalid_locator', () => readPage(projectRoot, PDF_SOURCE, '第 9999 页'));
  expectError('页码定位不接受绝对路径', 'invalid_locator', () => readPage(projectRoot, PDF_SOURCE, 'E:\\workspace-ai\\xuanxue\\liuyao\\corpus\\manifest.jsonl'));
  expectError('不存在的段落被拒', 'locator_not_found', () => readParagraph(projectRoot, PDF_SOURCE, '¶9999'));
}

console.log('\n=== 4) 页图白名单 ===');
{
  const asset = resolveAsset(projectRoot, PDF_SOURCE, 'page-001.jpg');
  check('合法页图可解析且为 jpeg', asset.contentType === 'image/jpeg' && fs.existsSync(asset.absolutePath), `${asset.relativePath} ${asset.bytes} 字节`);
  expectError('目录穿越被拒', 'invalid_asset', () => resolveAsset(projectRoot, PDF_SOURCE, '../manifest.jsonl'));
  expectError('反斜杠穿越被拒', 'invalid_asset', () => resolveAsset(projectRoot, PDF_SOURCE, '..\\..\\manifest.jsonl'));
  expectError('绝对路径被拒', 'invalid_asset', () => resolveAsset(projectRoot, PDF_SOURCE, 'E:\\workspace-ai\\xuanxue\\liuyao\\corpus\\manifest.jsonl'));
  expectError('非 jpg 扩展名被拒', 'invalid_asset', () => resolveAsset(projectRoot, PDF_SOURCE, 'page-001.md'));
  expectError('可执行扩展名被拒', 'invalid_asset', () => resolveAsset(projectRoot, PDF_SOURCE, 'page-001.exe'));
  expectError('URL 编码被拒', 'invalid_asset', () => resolveAsset(projectRoot, PDF_SOURCE, 'page-00%31.jpg'));
  expectError('越出子目录的页图名被拒', 'invalid_asset', () => resolveAsset(projectRoot, PDF_SOURCE, 'src-f3f838d501b1/page-001.jpg'));
  expectError('不存在的页图被拒', 'asset_not_found', () => resolveAsset(projectRoot, PDF_SOURCE, 'page-099.jpg'));
  expectError('对他来源取图需其自身目录存在', 'asset_not_found', () => resolveAsset(projectRoot, SCAN_SOURCE, 'page-099.jpg'));
}

console.log('\n=== 5) 完整出处可回到包内（source_id + ¶NNNN/页码） ===');
{
  const paragraph = readParagraph(projectRoot, PDF_SOURCE, '¶0002');
  check('出处三要素齐备', paragraph.cleanedPath === `corpus/cleaned/${PDF_SOURCE}.md` && paragraph.paragraph === '¶0002' && paragraph.pageNumber !== null, `${PDF_SOURCE} / ${paragraph.paragraph} / 第 ${paragraph.pageNumber} 页 / ${paragraph.cleanedPath}`);
  check('页图可从出处定位', fs.existsSync(path.join(projectRoot, `corpus/assets/${PDF_SOURCE}/page-${String(paragraph.pageNumber).padStart(3, '0')}.jpg`)), `page-${String(paragraph.pageNumber).padStart(3, '0')}.jpg`);
}

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
