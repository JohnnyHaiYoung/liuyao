// 决定性检查：那个 16.9KB 的 DOCX 里到底有多少文字？
// IFilter 说 51,461 汉字，自实现说 2,261 —— 文件总长决定了谁对。
import fs from 'node:fs';
import { readZip } from '../lib/office.ts';

const docx = 'E:\\workspace-ai\\xuanxue\\liuyao\\corpus\\originals\\五行所属行业\\六爻爻象详解.docx';
const raw = fs.readFileSync(docx);
const entries = readZip(raw);
const cjk = (value) => (value.match(/[\u4e00-\u9fff]/g) ?? []).length;

console.log(`DOCX 压缩包 ${raw.length} 字节，条目 ${entries.length} 个`);
let totalUncompressed = 0;
let totalCjk = 0;
for (const entry of entries) {
  if (entry.isDirectory) continue;
  totalUncompressed += entry.content.length;
  const text = entry.name.endsWith('.xml') || entry.name.endsWith('.rels') ? entry.content.toString('utf8') : '';
  const c = cjk(text);
  totalCjk += c;
  console.log(`  ${c === 0 ? '        ' : String(c).padStart(8)} 汉字  ${String(entry.content.length).padStart(8)} B  ${entry.name}`);
}
console.log(`合计：解压后 ${totalUncompressed} 字节 / ${totalCjk} 汉字（上限）`);
console.log(`结论：文件内可容纳的汉字上限约 ${totalCjk}，IFilter 报告的 51461 汉字${totalCjk >= 50000 ? '在文件内可以容纳' : '明显超出文件容量，IFilter 输出不是本文件内容'}`);

const ifilter = fs.readFileSync('E:\\workspace-ai\\xuanxue\\liuyao\\storage\\tmp\\ifilter-docx.txt', 'utf8');
const lines = ifilter.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 12);
console.log(`\nIFilter 输出示例（第 3/中间/倒数第 3 个非空行）：`);
for (const index of [2, Math.floor(lines.length / 2), lines.length - 3]) {
  console.log(`  [${index}] ${(lines[index] ?? '').slice(0, 90)}`);
}
