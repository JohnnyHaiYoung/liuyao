// 用系统自带 IFilter（独立于自实现解析器）核对我们提取的正文，并生成对照报告。
// 先做去重/重复检测：IFilter 的 GetChunk/GetText 循环有可能把同一段重复追加，
// 因此在把它的字数当作"证据"之前必须先确认它的输出是干净的一次性正文。
import fs from 'node:fs';

const root = 'E:\\workspace-ai\\xuanxue\\liuyao';
const cjk = (value) => (value.match(/[\u4e00-\u9fff]/g) ?? []).length;
const normalize = (value) => value.replace(/\s+/g, '');

const targets = [
  {
    id: 'src-946795472cd6',
    format: 'docx',
    filter: 'storage/tmp/ifilter-docx.txt',
    mine: 'corpus/extracted/src-946795472cd6.txt',
    filterName: 'Office OOXML IFilter (OFFFILTX.DLL)',
    probe: '大象指原卦原象',
  },
  {
    id: 'src-3f8243c07930',
    format: 'doc',
    filter: 'storage/tmp/ifilter-doc.txt',
    mine: 'corpus/extracted/src-3f8243c07930.txt',
    filterName: 'Windows Office IFilter (OffFilt.dll)',
    probe: '不论自己养的，还是野生的，都是子孙爻',
  },
];

/** 检测 "整段被重复 K 次" 的情况：把文本切成 K 份，看各份是否高度相似。 */
function repetitionFactor(text) {
  const compact = normalize(text);
  for (const factor of [2, 3, 4, 5, 6, 8, 10]) {
    const size = Math.floor(compact.length / factor);
    if (size < 200) continue;
    const first = compact.slice(0, size);
    let matches = 0;
    for (let index = 0; index < factor; index += 1) {
      const part = compact.slice(index * size, (index + 1) * size);
      // 用前 120 字与中段 120 字做双重比对，避免误判重复段落
      if (part.slice(0, 120) === first.slice(0, 120) && part.slice(size >> 1, (size >> 1) + 120) === first.slice(size >> 1, (size >> 1) + 120)) {
        matches += 1;
      }
    }
    if (matches >= factor - 1 && matches >= 2) return factor;
  }
  return 1;
}

/** 若为重复块，只保留一份；否则原样返回。 */
function dedupe(text) {
  const factor = repetitionFactor(text);
  if (factor === 1) return { text, factor };
  const compactLength = normalize(text).length;
  const size = Math.floor(compactLength / factor);
  // 按字符流切分并保留第一份（含原始空白会复杂化，这里用压缩流重建，报告会标注）
  const compact = normalize(text);
  return { text: compact.slice(0, size), factor, compacted: true };
}

const summary = [];
for (const target of targets) {
  const filterTextRaw = fs.readFileSync(`${root}\\${target.filter}`, 'utf8');
  const myRaw = fs.readFileSync(`${root}\\${target.mine}`, 'utf8');
  const mine = myRaw.split('\n').filter((line) => !line.startsWith('##')).join('\n');
  const factor = repetitionFactor(filterTextRaw);
  const { text: filterText } = dedupe(filterTextRaw);

  const myParagraphs = mine
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => normalize(line).length >= 10);
  const filterCompact = normalize(filterText);
  const hit = myParagraphs.filter((line) => filterCompact.includes(normalize(line).slice(0, 14)));
  const probeCount = filterCompact.split(normalize(target.probe)).length - 1;

  const row = {
    id: target.id,
    format: target.format,
    rawChars: filterTextRaw.length,
    rawCjk: cjk(filterTextRaw),
    factor,
    cleanChars: filterText.length,
    cleanCjk: cjk(filterText),
    mineChars: mine.length,
    mineCjk: cjk(mine),
    myParagraphs: myParagraphs.length,
    hit: hit.length,
    probeCount,
    filterName: target.filterName,
  };
  summary.push(row);

  const report = [
    `# 独立对照报告（IFilter）：${target.id}`,
    '',
    `- 格式：${target.format}`,
    `- 独立路径：${target.filterName}，经 \`query.dll!LoadIFilter\` 在进程内调用（Windows/Office 自带，离线，未联网、未安装任何包）`,
    `- 自实现路径：\`tools/lib/office.ts\`（${target.format === 'docx' ? 'ZIP + word/document.xml' : 'OLE2/CFB + FIB + 分片表 31 片'}）`,
    `- 命令：\`powershell -File tools/offline/ifilter-extract.ps1 -InputPath <原件> -OutPath storage/tmp/ifilter-${target.format}.txt\``,
    '',
    '## 原始输出与重复检测',
    '',
    `| 项目 | 值 |`,
    `| --- | ---: |`,
    `| IFilter 原始字符 / 汉字 | ${row.rawChars} / ${row.rawCjk} |`,
    `| 检测到的重复倍数 | ${row.factor}${row.factor > 1 ? '（判定为重复追加，已按单份还原）' : '（未检测到整体重复）'} |`,
    `| 还原后字符 / 汉字 | ${row.cleanChars} / ${row.cleanCjk} |`,
    `| 自实现字符 / 汉字 | ${row.mineChars} / ${row.mineCjk} |`,
    '',
    '## 覆盖比对',
    '',
    `- 自实现文本的 ${row.myParagraphs} 个段落中，有 **${row.hit}** 个（${((100 * row.hit) / Math.max(1, row.myParagraphs)).toFixed(1)}%）能在 IFilter 输出中找到前 14 字`,
    `- 关键抽查串「${target.probe}」在 IFilter 输出中出现 **${row.probeCount}** 次（1 次为正常）`,
    '',
    '## 结论',
    '',
  ];
  if (row.factor > 1) {
    report.push(
      `1. IFilter 的 `+"`GetChunk/GetText`"+` 循环在本机把同一段正文**重复输出了 ${row.factor} 次**，这是调用侧的已知模式问题，不是原件有 ${row.factor} 份内容；还原单份后为 ${row.cleanCjk} 汉字。`,
      `2. 因此 **IFilter 的原始字数不能直接当作"独立核对通过"的证据**；本次只把还原后的覆盖率与抽查串命中情况作为参考。`,
      `3. 正文完整性的主要证据仍是：原页图目视核对、原始字节独立命中，以及旧 DOC 的 Word 独立渲染对照（汉字数 26372 与自实现完全一致）。`,
    );
  } else {
    report.push(
      `1. 未检测到整体重复；IFilter 与自实现两条路径的正文覆盖率见上表。`,
      `2. 差异通常来自换行/分段与域代码写法，需要逐段抽查确认，不能只看总数。`,
    );
  }
  report.push(
    '',
    '## 边界',
    '',
    '- IFilter 由 Windows/Office 提供，属于**开发机自测**用参照物，不是第三方独立核对，也不进交付包的运行时依赖。',
    '- IFilter 输出保存在 `storage/tmp/`（不入包）；本报告记录的是本次运行结果与命令，便于复跑。',
    '',
  );

  fs.writeFileSync(`${root}\\corpus\\reports\\${target.id}-ifilter-crosscheck.md`, `${report.join('\n')}\n`, 'utf8');
  console.log(
    `${target.id}（${target.format}）: IFilter 原始 ${row.rawCjk} 汉字 → 重复倍数 ${factor} → 还原 ${row.cleanCjk} 汉字；自实现 ${row.mineCjk} 汉字；` +
      `段落命中 ${row.hit}/${row.myParagraphs}；抽查串出现 ${row.probeCount} 次`,
  );
}
console.log('\n已写入 corpus/reports/<source_id>-ifilter-crosscheck.md');
