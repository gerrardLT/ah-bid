/**
 * 中标价基准表：按城市 × 项目类型给出价格分布，并计算下浮率。
 *
 * 数据来源两路：
 *   中标价 —— bid_body_result（正文提取，1,861 条可信）+ bid_result（附件，181 条）
 *   控制价 —— tender_doc.money_json（1,812 份招标文件里的「最高投标限价」）
 *
 * 下浮率 = (控制价 - 中标价) / 控制价。两路数据分属不同公告（招标公告 vs 中标公示），
 * 所以必须靠项目名称匹配。匹配规则：去掉「招标公告/中标候选人公示/…」等后缀后取前 18 字。
 *
 * 用法：node --no-warnings src/price-benchmark.ts [--out=path.md]
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { collectPairs, groupByType, summarize, typeOfTitle } from './lib/price-stats.ts';

const DATA = 'data';
const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const OUT = argOf('out');

const db = new DatabaseSync(join(DATA, 'index.db'), { readOnly: true });

/**
 * 项目名归一化已抽到 src/lib/price-stats.ts（全等匹配 + 去后缀 + 去括号）。
 * 抽出的原因：price-benchmark、tech-bid 各写一套，导致三套下浮率数字互相不一致。
 */

// ---- 1) 汇总中标价（两个来源合并，按公告去重） ----
interface Row {
  g: string;
  title: string;
  city: string | null;
  price: number;
  src: string;
}
const rows: Row[] = [];
for (const r of db
  .prepare(
    `SELECT bb.announcement_guid g, bb.title, bb.city, bb.winner_price price
     FROM bid_body_result bb
     WHERE bb.winner IS NOT NULL AND bb.winner_price >= 1000 AND bb.confidence='high'`,
  )
  .all() as Array<{ g: string; title: string; city: string | null; price: number }>) {
  rows.push({ ...r, src: '正文' });
}
for (const r of db
  .prepare(
    `SELECT b.announcement_guid g, a.title, a.city, b.winner_price price
     FROM bid_result b JOIN announcement a ON a.guid = b.announcement_guid
     WHERE b.winner_price >= 1000`,
  )
  .all() as Array<{ g: string; title: string; city: string | null; price: number }>) {
  rows.push({ ...r, src: '附件' });
}

/** 项目类型：用标题关键词判定（已抽到 price-stats，保持与 tech-bid 同一套口径） */

/** 统计函数已抽到 price-stats.ts（summarize），下面统一调用。 */
const wan = (v: number) => (v / 10000).toFixed(v >= 10000000 ? 0 : 1);

const out: string[] = [];
out.push('# 中标价基准表');
out.push('');
out.push(`> 样本：${rows.length} 条中标价（正文提取 ${rows.filter((r) => r.src === '正文').length} + 附件提取 ${rows.filter((r) => r.src === '附件').length}）`);
out.push(`> 口径：只统计「中标人 + 中标价」双齐全且价格 ≥ 1000 元的记录；单位万元`);
out.push('');

// ---- 2) 按城市 ----
const byCity = new Map<string, number[]>();
for (const r of rows) {
  const c = r.city ?? '(未知)';
  byCity.set(c, [...(byCity.get(c) ?? []), r.price]);
}
out.push('## 一、按城市');
out.push('');
out.push('| 城市 | 样本 | 均价 | 中位数 | P25 | P75 | 区间 |');
out.push('|---|---|---|---|---|---|---|');
for (const [c, arr] of [...byCity.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (arr.length < 5) continue;
  const s = summarize(arr);
  out.push(`| ${c} | ${s.n} | ${wan(s.avg)} | ${wan(s.p50)} | ${wan(s.p25)} | ${wan(s.p75)} | ${wan(s.min)}~${wan(s.max)} |`);
}
out.push('');

// ---- 3) 按项目类型 ----
const byType = new Map<string, number[]>();
for (const r of rows) {
  const t = typeOfTitle(r.title);
  byType.set(t, [...(byType.get(t) ?? []), r.price]);
}
out.push('## 二、按项目类型');
out.push('');
out.push('| 类型 | 样本 | 均价 | 中位数 | P25 | P75 |');
out.push('|---|---|---|---|---|---|');
for (const [t, arr] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (arr.length < 5) continue;
  const s = summarize(arr);
  out.push(`| ${t} | ${s.n} | ${wan(s.avg)} | ${wan(s.p50)} | ${wan(s.p25)} | ${wan(s.p75)} |`);
}
out.push('');

// ---- 4) 下浮率：控制价 vs 中标价，按项目名全等匹配 ----
// 配对、口径分层、多标段去重、双闸全部由 price-stats 统一实现——
// 这里的 437 条曾是全项目唯一的权威数字，但样本含 82 个重复项目，已由共享模块修正。
const cal = collectPairs(db, 'limit');
const pairs = cal.pairs;

out.push('## 三、下浮率（控制价 → 中标价）');
out.push('');
if (pairs.length >= 10) {
  const rates = pairs.map((p) => p.rate * 100);
  const s = summarize(rates);
  out.push(`可匹配样本 **${pairs.length}** 条（招标文件里的最高投标限价 ↔ 中标公告里的中标价，按项目名匹配）`);
  out.push('');
  out.push(`- 平均下浮 **${s.avg.toFixed(1)}%**`);
  out.push(`- 中位数 **${s.p50.toFixed(1)}%**`);
  out.push(`- 四分位区间 ${s.p25.toFixed(1)}% ~ ${s.p75.toFixed(1)}%`);
  out.push(`- 极值 ${s.min.toFixed(1)}% ~ ${s.max.toFixed(1)}%`);
  out.push('');
  out.push('| 项目类型 | 样本 | 平均下浮 | 中位数 |');
  out.push('|---|---|---|---|');
  for (const st of groupByType(pairs)) {
    out.push(`| ${st.type} | ${st.n} | ${st.avg.toFixed(1)}% | ${st.p50.toFixed(1)}% |`);
  }
  out.push('');
  out.push('样本明细（前 8 条）：');
  out.push('');
  out.push('| 项目 | 控制价(万) | 中标价(万) | 下浮 |');
  out.push('|---|---|---|---|');
  for (const p of pairs.slice(0, 8)) {
    out.push(`| ${p.title.slice(0, 26)} | ${wan(p.ctrl)} | ${wan(p.win)} | ${(p.rate * 100).toFixed(1)}% |`);
  }
} else {
  out.push(`可匹配样本仅 ${pairs.length} 条，不足以计算下浮率。`);
  out.push('');
  out.push('原因：招标文件（含控制价）与中标公告是不同公告，需按项目名匹配；');
  out.push('两边标题写法差异较大（如带「（二次）」「标段X」等），当前匹配率偏低。');
}
out.push('');
out.push('---');
out.push('');
out.push('> 说明：中标价来自公告正文提取，个别可能因金额单位或排版导致偏差，已剔除 <1000 元与下浮率越界的记录。');

const text = out.join('\n');
if (OUT) {
  const dir = OUT.includes('/') ? OUT.slice(0, OUT.lastIndexOf('/')) : '.';
  mkdirSync(dir, { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  console.log(`已生成：${OUT}`);
} else {
  console.log(text);
}
console.error(`\n[统计] 中标价 ${rows.length} 条｜控制价可匹配 ${cal.ctrlProjects} 个项目名（多标段丢弃 ${cal.droppedCtrl}）｜下浮率样本 ${pairs.length} 条（双闸剔除 ${cal.droppedGate}）`);
db.close();
