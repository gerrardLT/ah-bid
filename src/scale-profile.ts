/**
 * 造价档位 → 规模画像表。
 *
 * 背景：工程概况（建筑面积/结构类型/层数）在当前数据里拿不到——验证了四条路
 * （投标人须知前附表 1.4 字段/份、招标计划 0.5 字段/份、工程量清单在压缩包里、
 * 评分细则反推仅 4.4%）。改用「造价 + 工期」这个维度描述规模。
 *
 * 数据：
 *   控制价 —— tender_control_price（真限价 1,282）
 *   工期   —— tender_doc.duration_json（纯数字数组，如 [90] / [1,150]）
 *   两者同属招标公告，按 announcement_guid 直接配对（不靠项目名，匹配率 88%）
 *   下浮率 —— 控制价 ↔ 中标价按项目名匹配（跨公告，480 条）
 *
 * 用法：node --no-warnings src/scale-profile.ts [--out=path.md]
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const DATA = 'data';
const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const OUT = argOf('out');

const db = new DatabaseSync(join(DATA, 'index.db'), { readOnly: true });

/** 工期解析：duration_json 是纯数字数组，取第一个合理值。
 *  > 2000 天不像单个施工合同的工期；
 *  < 30 天多为「投标有效期」之类混入，一并排除。 */
const parseDays = (json: string | null): number | null => {
  try {
    const arr = JSON.parse(json || '[]') as unknown[];
    if (!Array.isArray(arr)) return null;
    for (const x of arr) {
      const v = Number(x);
      if (Number.isFinite(v) && v >= 30 && v <= 2000) return v;
    }
  } catch {
    /* ignore */
  }
  return null;
};

// ---- 1) 控制价 ∩ 工期（同公告） ----
const rows = db
  .prepare(
    `SELECT c.announcement_guid ag, c.title, c.city, c.amount ctrl, d.duration_json dj
     FROM tender_control_price c JOIN tender_doc d ON d.announcement_guid = c.announcement_guid
     WHERE c.price_kind='限价' AND c.amount > 1000`,
  )
  .all() as Array<{ ag: string; title: string; city: string | null; ctrl: number; dj: string | null }>;

const paired = rows
  .map((r) => ({ ...r, days: parseDays(r.dj) }))
  .filter((r) => r.days !== null) as Array<{ ag: string; title: string; city: string | null; ctrl: number; days: number }>;

// ---- 2) 下浮率（跨公告，按项目名） ----
const SUFFIX = /(中标候选人变更公示|中标候选人公示|中标结果公示|中标结果公告|定标候选人公示|成交结果公告|中标公告|招标公告|公开招标公告|采购公告|结果公示|公示|公告)$/g;
const norm = (s: string | null): string => {
  let t = (s ?? '').replace(/[\s　]/g, '');
  for (let i = 0; i < 3; i++) t = t.replace(SUFFIX, '');
  return t.replace(/[（(][^）)]{0,20}[）)]/g, '');
};
const win = new Map<string, number>();
for (const r of db
  .prepare("SELECT title, winner_price p FROM bid_body_result WHERE winner_price >= 1000 AND confidence='high'")
  .all() as Array<{ title: string; p: number }>) {
  win.set(norm(r.title), r.p);
}
for (const r of db
  .prepare(
    `SELECT a.title, b.winner_price p FROM bid_result b JOIN announcement a ON a.guid=b.announcement_guid
     WHERE b.winner_price >= 1000`,
  )
  .all() as Array<{ title: string; p: number }>) {
  if (!win.has(norm(r.title))) win.set(norm(r.title), r.p);
}

// ---- 3) 分档统计 ----
const TIERS: Array<[number, number, string]> = [
  [0, 500, '<500万'],
  [500, 1000, '500-1000万'],
  [1000, 3000, '1000-3000万'],
  [3000, 5000, '3000-5000万'],
  [5000, 10000, '5000万-1亿'],
  [10000, 30000, '1-3亿'],
  [30000, Infinity, '>3亿'],
];
const med = (a: number[]): number => (a.length ? a[Math.floor(a.length / 2)] : NaN);
const pct = (a: number[], q: number): number => (a.length ? a[Math.floor(a.length * q)] : NaN);

interface Tier {
  label: string;
  n: number;
  dayMed: number;
  d25: number;
  d75: number;
  rateMed: number | null;
  rateN: number;
}

const tiers: Tier[] = [];
for (const [lo, hi, label] of TIERS) {
  const seg = paired.filter((r) => r.ctrl / 10000 >= lo && r.ctrl / 10000 < hi);
  if (!seg.length) continue;
  const ds = seg.map((r) => r.days).sort((a, b) => a - b);
  const rates = seg
    .map((r) => win.get(norm(r.title)))
    .filter((v): v is number => v !== undefined)
    .map((w, i) => {
      const ctrl = seg.filter((r) => win.get(norm(r.title)) !== undefined)[i].ctrl;
      return ((ctrl - w) / ctrl) * 100;
    })
    .filter((x) => x > -5 && x < 45)
    .sort((a, b) => a - b);
  tiers.push({
    label,
    n: seg.length,
    dayMed: med(ds),
    d25: pct(ds, 0.25),
    d75: pct(ds, 0.75),
    rateMed: rates.length ? med(rates) : null,
    rateN: rates.length,
  });
}

// ---- 4) 输出 ----
const out: string[] = [];
out.push('# 造价档位 → 规模画像');
out.push('');
out.push(`> 样本：${paired.length} 个「控制价 + 工期」配对的招标项目（同为招标公告，按 announcement_guid 配对，匹配率 ${((paired.length / rows.length) * 100).toFixed(0)}%）`);
out.push(`> 用途：拿不到建筑面积/结构类型时，用「造价 + 工期」描述规模量级，作为施工部署与资源投入的参照`);
out.push('');

out.push('## 一、造价档位表');
out.push('');
out.push('| 控制价档位 | 样本 | 工期中位 | 工期 P25~P75 | 下浮中位 |');
out.push('|---|---|---|---|---|');
for (const t of tiers) {
  out.push(
    `| ${t.label} | ${t.n} | ${t.dayMed} 天 | ${t.d25}~${t.d75} 天 | ${t.rateMed === null ? '—' : t.rateMed.toFixed(1) + '%'}（${t.rateN}） |`,
  );
}
out.push('');

out.push('## 二、怎么用这张表');
out.push('');
out.push('拿到一个新项目的**控制价**后：');
out.push('');
out.push('```');
out.push('1. 定位档位   → 查工期中位数，判断招标文件给的工期是否宽松/紧张');
out.push('2. 查工序节奏 → 按工期推算基础/主体/装修的大致时间分配');
out.push('3. 估资源投入 → 工期紧则需增加人材机，工期宽则可平铺');
out.push('4. 报参考价   → 控制价 ×（1 - 下浮中位）作为基准，再按竞争烈度上下调 3-5 点');
out.push('```');
out.push('');
out.push('**例**：控制价 4,000 万的房建项目，查表落在 3000-5000万 档——工期中位 180 天、P25~P75 是 45~270 天。');
out.push('如果招标文件要求 150 天，说明**工期偏紧**，施工部署要考虑平行作业、增加班组；');
out.push('如果要求 240 天，则相对宽松，可按常规顺序施工。');
out.push('');

out.push('## 三、为什么不用建筑面积');
out.push('');
out.push('尝试过四条路从招标文件抽工程概况，均失败：');
out.push('');
out.push('| 路径 | 实测 |');
out.push('|---|---|');
out.push('| 投标人须知前附表 | 平均 1.4 字段/份，只有「质量标准」「招标范围」 |');
out.push('| 招标计划（423 份 PDF） | 平均 0.5 字段/份 |');
out.push('| 工程量清单章节 | 章节仅 1-2 页（索引页），真清单在 .rar/.zip 里 |');
out.push('| 评分细则反推特征 | 仅 4.4% 文件能反推出项目特征 |');
out.push('');
out.push('**根因**：招标文件本身不含完整工程概况——建筑面积、结构类型、层数在施工图纸和立项/可研文件里，不在招标文件中。');
out.push('');
out.push('而「造价 + 工期」是招标文件里**必然有**的两个数，且造价档位本身就等价于规模量级。');
out.push('');

out.push('## 四、已知偏差');
out.push('');
out.push('| 档位 | 偏差 | 原因 |');
out.push('|---|---|---|');
out.push('| 1-3亿 | 工期中位偏低 | 该档混入较多「设计/监理/咨询」类项目，工期按服务期算，不是施工期 |');
out.push('| >3亿 | P25 仅 90 天 | 同上，且有大型项目的分标段情况 |');
out.push('');
out.push('> 若只用于房建/市政施工类项目，建议按项目类型过滤后再查表（`--type` 参数待加）。');
out.push('');
out.push('---');
out.push('');
out.push('> 数据源：tender_control_price（price_kind=限价）+ tender_doc.duration_json + bid_body_result/bid_result');

const text = out.join('\n');
if (OUT) {
  const dir = OUT.includes('/') ? OUT.slice(0, OUT.lastIndexOf('/')) : '.';
  mkdirSync(dir, { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  console.log(`已生成：${OUT}`);
} else {
  console.log(text);
}
console.error(`\n[统计] 控制价∩工期 ${paired.length} 条｜档位 ${tiers.length} 个｜下浮率可用 ${tiers.reduce((s, t) => s + t.rateN, 0)} 条`);
db.close();
