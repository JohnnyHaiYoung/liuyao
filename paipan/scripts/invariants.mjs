// 4096 组合结构不变量（阶段 3）
//
// 目的（任务书第 6 节）：结构性不变量可覆盖全部 4^6 种爻值组合，能查出程序自相矛盾、漏卦与倒序；
// **不能**单独证明纳甲等传统规则正确（那要靠原页核对与独立实现对照，见 core-check.mjs / names-check.mjs）。
import { buildChart, canonicalize } from '../src/core.ts';
import { fromManual } from '../src/calendar.ts';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? '通过' : '不通过'}] ${name}${detail ? '：' + detail : ''}`);
};

const dayGanzhi = '庚戌';
const monthBranch = '未';
const calendar = fromManual(dayGanzhi, monthBranch);

const hexagramCount = new Map();
const palaceCount = new Map();
const movingCount = new Map();
let total = 0;
const issues = [];
const canonicalHashes = new Map();

for (let a = 6; a <= 9; a += 1) {
  for (let b = 6; b <= 9; b += 1) {
    for (let c = 6; c <= 9; c += 1) {
      for (let d = 6; d <= 9; d += 1) {
        for (let e = 6; e <= 9; e += 1) {
          for (let f = 6; f <= 9; f += 1) {
            const values = [a, b, c, d, e, f];
            total += 1;
            const chart = buildChart(values, calendar);
            const code = chart.chart.original.code;
            hexagramCount.set(code, (hexagramCount.get(code) ?? 0) + 1);
            const palaceKey = `${chart.chart.palace.name}${chart.chart.palace.stage}`;
            palaceCount.set(palaceKey, (palaceCount.get(palaceKey) ?? 0) + 1);
            const moving = chart.input.movingPositions.length;
            movingCount.set(moving, (movingCount.get(moving) ?? 0) + 1);

            // 逐项不变量
            if (![1, 2, 3, 4, 5, 6].includes(chart.chart.shiPosition)) issues.push(`${values} 世位越界`);
            if (((chart.chart.shiPosition + 2) % 6) + 1 !== chart.chart.yingPosition) issues.push(`${values} 世应不合规则`);
            if (chart.lines.length !== 6) issues.push(`${values} 爻数不为 6`);
            for (const line of chart.lines) {
              if (!line.najia || !line.najia.stem || !line.najia.branch || !line.najia.element) issues.push(`${values} 第${line.position}爻缺纳甲`);
              if (!['父母', '兄弟', '子孙', '妻财', '官鬼'].includes(line.sixRelative ?? '')) issues.push(`${values} 第${line.position}爻六亲非法`);
            }
            const movingExpected = values.filter((v) => v === 6 || v === 9).length;
            if (movingExpected === 0 && chart.chart.changed !== null) issues.push(`${values} 无动爻却有变卦`);
            if (movingExpected > 0 && chart.chart.changed === null) issues.push(`${values} 有动爻却无变卦`);
            if (chart.chart.changed) {
              const changedCode = chart.chart.changed.code;
              const diff = chart.chart.original.code.split('').filter((bit, index) => bit !== changedCode[index]).length;
              if (diff !== movingExpected) issues.push(`${values} 变卦差异位数 ${diff} ≠ 动爻数 ${movingExpected}`);
            }
            if ((chart.chart.voidBranches ?? []).join('') !== '寅卯') issues.push(`${values} 庚戌日旬空应为寅卯`);
            const hash = JSON.stringify(canonicalize(chart));
            canonicalHashes.set(values.join(''), hash);
          }
        }
      }
    }
  }
}

check('遍历组合数 = 4096', total === 4096, `实际 ${total}`);
check('本卦编码恰 64 种', hexagramCount.size === 64, `实际 ${hexagramCount.size}`);
check('每卦出现次数 = 64', [...hexagramCount.values()].every((v) => v === 64), `最小 ${Math.min(...hexagramCount.values())} / 最大 ${Math.max(...hexagramCount.values())}`);
check('八宫 × 8 阶段 = 64 类', palaceCount.size === 64, `实际 ${palaceCount.size}；每类出现 ${[...new Set(palaceCount.values())].join('/')} 次`);
const expectedMoving = [1, 6, 15, 20, 15, 6, 1]; // C(6,k)；乘 2^6 后即实际组合数
check(
  '动爻数分布 = C(6,k)·2^6',
  [0, 1, 2, 3, 4, 5, 6].every((k) => (movingCount.get(k) ?? 0) === expectedMoving[k] * 64),
  [0, 1, 2, 3, 4, 5, 6].map((k) => `${k}动:${movingCount.get(k) ?? 0}`).join(' '),
);
check('逐项不变量无违例', issues.length === 0, issues.slice(0, 5).join('；'));
check('canonical 唯一性（不同输入 → 不同输出）', new Set(canonicalHashes.values()).size === 4096, `不同结果 ${new Set(canonicalHashes.values()).size} 种`);

// 倒序检测：把同一组爻值反序输入，应得到不同的本卦编码（除非回文）
const reversed = buildChart([8, 7, 8, 8, 8, 7].slice().reverse(), calendar);
check('顺序敏感（反序得到不同本卦）', reversed.chart.original.code !== '010001', `反序本卦 ${reversed.chart.original.name}`);
void expectedMoving;

const failed = results.filter((item) => !item.pass);
console.log(`\n合计：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项不通过` : ''}`);
process.exitCode = failed.length === 0 ? 0 : 1;
