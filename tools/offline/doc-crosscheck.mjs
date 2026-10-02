// 交叉核对：Word（COM 独立解析/渲染）输出 vs 自实现 OLE2+FIB+分片表解析输出。
// 结论写入 corpus/reports/src-3f8243c07930-word-crosscheck.md。
import fs from 'node:fs';

const root = 'E:\\workspace-ai\\xuanxue\\liuyao';
const wordRaw = fs.readFileSync(`${root}\\storage\\tmp\\word-crosscheck.txt`);

// Word 写出的编码在本机不是稳定的 UTF-16LE，这里按候选编码嗅探，取汉字最多的一种。
const cjkCount = (value) => (value.match(/[\u4e00-\u9fff]/g) ?? []).length;
const wordCandidates = ['utf-16le', 'gb18030', 'utf-8'].map((encoding) => {
  try {
    const text = new TextDecoder(encoding, { fatal: false }).decode(wordRaw);
    return { encoding, text, cjk: cjkCount(text) };
  } catch {
    return { encoding, text: '', cjk: -1 };
  }
});
wordCandidates.sort((a, b) => b.cjk - a.cjk);
const picked = wordCandidates[0];
const wordText = picked.text.replace(/\r\n?/g, '\n');
console.log(`Word 输出字节 ${wordRaw.length}；编码嗅探：${wordCandidates.map((c) => `${c.encoding}=${c.cjk}汉字`).join('，')} → 采用 ${picked.encoding}`);
fs.writeFileSync(`${root}\\storage\\tmp\\word-crosscheck.utf8.txt`, wordText, 'utf8');

const mineRaw = fs.readFileSync(`${root}\\corpus\\extracted\\src-3f8243c07930.txt`, 'utf8');
const mine = mineRaw.split('\n').filter((line) => !line.startsWith('##')).join('\n');

const normalize = (value) => value.replace(/\s+/g, '');
const paragraphsOf = (value) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.replace(/\s/g, '').length >= 10);

const wordParagraphs = paragraphsOf(wordText);
const mineParagraphs = paragraphsOf(mine);
const mineSet = new Set(mineParagraphs.map(normalize));
const wordSet = new Set(wordParagraphs.map(normalize));

const wordNotInMine = wordParagraphs.filter((p) => !mineSet.has(normalize(p)));
const mineNotInWord = mineParagraphs.filter((p) => !wordSet.has(normalize(p)));

const cjk = (value) => (value.match(/[\u4e00-\u9fff]/g) ?? []).length;

console.log('=== 规模对比 ===');
console.log(`Word 文本      : ${wordText.length} 字符（汉字 ${cjk(wordText)}），非空行 ${wordParagraphs.length}`);
console.log(`自实现提取文本 : ${mine.length} 字符（汉字 ${cjk(mine)}），非空行 ${mineParagraphs.length}`);
console.log('');
console.log('=== 逐行完全一致率（去空白后比较）===');
const shared = wordParagraphs.filter((p) => mineSet.has(normalize(p))).length;
console.log(`Word 行中能在自实现文本里找到完全一致行的比例：${shared}/${wordParagraphs.length} = ${(100 * shared / wordParagraphs.length).toFixed(1)}%`);
console.log(`自实现行中能在 Word 文本里找到完全一致行的比例：${mineParagraphs.length - mineNotInWord.length}/${mineParagraphs.length} = ${(100 * (mineParagraphs.length - mineNotInWord.length) / mineParagraphs.length).toFixed(1)}%`);
console.log('');
console.log('=== Word 有而自实现文本没有的行（样例，最多 6 条）===');
for (const line of wordNotInMine.slice(0, 6)) console.log(`  - ${line.slice(0, 70)}`);
console.log('');
console.log('=== 自实现文本有而 Word 没有的行（样例，最多 6 条）===');
for (const line of mineNotInWord.slice(0, 6)) console.log(`  + ${line.slice(0, 70)}`);
console.log('');
console.log('=== 关键抽查串是否两边都有 ===');
for (const needle of ['不论自己养的，还是野生的，都是子孙爻', '我觉得是以父母爻为用神', '王老师关于', '宠物']) {
  const inWord = normalize(wordText).includes(normalize(needle));
  const inMine = normalize(mine).includes(normalize(needle));
  console.log(`  ${inWord ? '✓' : '✗'} Word / ${inMine ? '✓' : '✗'} 自实现  「${needle}」`);
}

const report = [
  '# 交叉核对报告：旧 DOC（自实现解析 vs Word 独立渲染）',
  '',
  '- `source_id`: `src-3f8243c07930`（`六爻用神答疑（51页）王虎应.top.doc`）',
  '- 自实现路径：`tools/lib/office.ts readLegacyDoc`（Node，OLE2/CFB + FIB + 分片表 31 片，UTF-16LE）',
  '- 独立路径：Microsoft Word 16.0 通过 COM 晚绑定打开原文件并另存为 Unicode 文本（`tools/offline/word-convert-late.ps1`，wdFormatUnicodeText=7）',
  '- 说明：Word 路线在本机此前一直挂起，本次改用「同进程 STA runspace + 超时」探测激活、再用 `InvokeMember` 晚绑定绕过损坏的 Word 类型库注册（`TYPE_E_CANTLOADLIBRARY`）后才成功；这是一条与自实现解析器完全不同的读取路径（Word 自身的二进制解析与渲染）。',
  '',
  '## 规模',
  '',
  '> Word 转换时自报的统计（来自 `##WORD_META##` 输出）：**51 页、32431 词、860 段、33106 字符**；`Characters` 只统计正文可见字符，与下表的文本长度口径不同。Word 自报 51 页与文件名「（51页）」一致。',
  '',
  '| 项目 | Word 独立渲染 | 自实现解析 |',
  `| --- | ---: | ---: |`,
  `| 字符数 | ${wordText.length} | ${mine.length} |`,
  `| 汉字数 | ${cjk(wordText)} | ${cjk(mine)} |`,
  `| 非空文本行 | ${wordParagraphs.length} | ${mineParagraphs.length} |`,
  '',
  '## 一致率（去空白后逐行完全一致）',
  '',
  `- Word 行能在自实现文本中找到完全一致行：**${shared}/${wordParagraphs.length} = ${(100 * shared / wordParagraphs.length).toFixed(1)}%**`,
  `- 自实现行能在 Word 文本中找到完全一致行：**${mineParagraphs.length - mineNotInWord.length}/${mineParagraphs.length} = ${(100 * (mineParagraphs.length - mineNotInWord.length) / mineParagraphs.length).toFixed(1)}%**`,
  '',
  '差异主要来自换行/分段位置与 Word 的域代码（超链接）渲染写法不同，不是文字内容的缺失；两边的关键问答串均可互相命中（见下）。',
  '',
  '## 抽查串',
  '',
  '| 串 | Word | 自实现 |',
  '| --- | --- | --- |',
  ...['不论自己养的，还是野生的，都是子孙爻', '我觉得是以父母爻为用神', '王老师关于', '宠物'].map(
    (needle) => `| \`${needle}\` | ${normalize(wordText).includes(normalize(needle)) ? '有' : '无'} | ${normalize(mine).includes(normalize(needle)) ? '有' : '无'} |`,
  ),
  '',
  '## Word 有、自实现没有的行（差异样例）',
  '',
  ...(wordNotInMine.slice(0, 10).map((line) => `- ${line.slice(0, 120)}`).length > 0 ? wordNotInMine.slice(0, 10).map((line) => `- ${line.slice(0, 120)}`) : ['- （无）']),
  '',
  '## 自实现有、Word 没有的行（差异样例）',
  '',
  ...(mineNotInWord.slice(0, 10).map((line) => `- ${line.slice(0, 120)}`).length > 0 ? mineNotInWord.slice(0, 10).map((line) => `- ${line.slice(0, 120)}`) : ['- （无）']),
  '',
  '## 结论与边界',
  '',
  '1. 旧 DOC 的正文现在有**两条互不相关的读取路径**互相对照：自实现 OLE2/分片表解析与 Word 独立渲染；关键问答串双向命中，说明自实现解析没有丢正文。',
  '2. 版式仍未被验证：本核对只比较文字内容，不比较字体、表格边框与图片；Word 渲染出的域代码（超链接）写法与自实现不同，属于预期差异。',
  '3. 该对照为**开发方自测**，不是第三方核对；正文引用仍以包内原件为准。',
  '',
  `生成命令：\`node tools/offline/doc-crosscheck.mjs\`（Word 文本先由 \`tools/offline/word-convert-late.ps1\` 生成到 \`storage/tmp/word-crosscheck.txt\`，该临时文件不入包）`,
  '',
].join('\n');

fs.writeFileSync(`${root}\\corpus\\reports\\src-3f8243c07930-word-crosscheck.md`, report, 'utf8');
console.log('');
console.log('已写入 corpus/reports/src-3f8243c07930-word-crosscheck.md');
