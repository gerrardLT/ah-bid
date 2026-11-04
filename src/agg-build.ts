/**
 * 事实表构建：把 4 张源表拼成一张 4,269 行的「项目事实表」。
 *
 * 为什么必须在 TS 里做：
 *   bid_body_result（中标公告，nature=2）与 tender_control_price / tender_buyer
 *   （招标公告，nature=1）**guid 完全不同，连不上**（实测 JOIN = 0 行）。
 *   唯一能连的是「归一化标题」，而 normalizeTitle 是 TS 函数。
 *   在 Python 里复刻它 = 制造第二套口径 —— price-stats.ts 文件头的 20.3/18.9/15.0
 *   三个数字就是上一次这么干的后果。
 *
 * 为什么不建新 SQLite 库：466KB 的 JSON 一次性读进内存就够了；
 *   Windows 上 os.replace 打开中的 db 会 PermissionError，会变成"聚合永远不更新"的隐蔽故障。
 *
 * 为什么不预聚合：城市 18 × 行业 10 × 规模 6 × 窗口 6 × 口径 2 = 12,960 种组合，
 *   预聚合要 6,480 份快照，加一个维度全部作废。事实表 pivot 0.8ms，组合数完全不用管。
 *
 * 用法：
 *   node --no-warnings src/agg-build.ts              # 生成 data/agg/facts.json
 *   node --no-warnings src/agg-build.ts --dry        # 只统计不写
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { normalizeTitle, typeOfTitle } from './lib/price-stats.ts';

const DRY = process.argv.includes('--dry');
const OUT = 'data/agg/facts.json';

const db = new DatabaseSync(join('data', 'index.db'), { readOnly: true });

interface Fact {
  guid: string;
  title: string;
  city: string | null;
  pubDate: string;
  /** typeOfTitle 推断：房建/市政/水利/电力/光伏/园林/智能化/监理设计/其他 */
  type: string;
  /** announcement.primary_tag，62% 为空，只作辅助 */
  tag: string | null;
  winner: string | null;
  winPrice: number | null;
  /** 配上的控制价（限价优先，其次估算） */
  ctrl: number | null;
  ctrlKind: string | null;
  /** 下浮率 0~1，只有 ctrl 和 winPrice 都有且合理时才算 */
  rate: number | null;
  buyer: string | null;
  bidderCount: number | null;
}

// ---------- 1. 中标结果（驱动表，4,269 行） ----------
// 注意：bid_body_result 没有 bidder_count（那只在 PDF 来源的 bid_result 里），
// 所以事实表的 bidderCount 恒为 null，等以后从正文抽"投标家数"再补。
const wins = db
  .prepare(
    `SELECT announcement_guid AS guid, title, city, pub_date AS pubDate,
            winner, winner_price AS winPrice
     FROM bid_body_result
     WHERE winner IS NOT NULL AND winner <> ''`,
  )
  .all() as unknown as Array<{
  guid: string;
  title: string;
  city: string | null;
  pubDate: string;
  winner: string;
  winPrice: number | null;
}>;

// ---------- 2. 控制价（按归一化标题建索引） ----------
// 同一标题多个不同金额 → 视为多标段，丢弃（与 loadControl 同口径）
const ctrlRows = db
  .prepare(
    `SELECT title, amount, price_kind AS kind FROM tender_control_price
     WHERE amount > 1000 AND title IS NOT NULL`,
  )
  .all() as unknown as Array<{ title: string; amount: number; kind: string }>;

const ctrlByNorm = new Map<string, { amount: number; kind: string }>();
const ctrlMulti = new Set<string>();
for (const r of ctrlRows) {
  const k = normalizeTitle(r.title);
  if (!k) continue;
  const prev = ctrlByNorm.get(k);
  if (!prev) {
    ctrlByNorm.set(k, { amount: r.amount, kind: r.kind });
  } else if (Math.round(prev.amount) !== Math.round(r.amount)) {
    // 同标题不同金额：多标段或口径不同，两种都不能直接当"这个项目的控制价"
    ctrlMulti.add(k);
  }
}
for (const k of ctrlMulti) ctrlByNorm.delete(k);

// ---------- 3. 招标人（按归一化标题建索引） ----------
const buyerRows = db
  .prepare(`SELECT title, buyer FROM tender_buyer WHERE buyer IS NOT NULL AND buyer <> ''`)
  .all() as unknown as Array<{ title: string; buyer: string }>;
const buyerByNorm = new Map<string, string>();
for (const r of buyerRows) {
  const k = normalizeTitle(r.title);
  if (k && !buyerByNorm.has(k)) buyerByNorm.set(k, r.buyer);
}

// ---------- 4. 行业标签 ----------
const tagRows = db
  .prepare(`SELECT guid, primary_tag AS tag FROM announcement WHERE bulletin_nature = '2'`)
  .all() as unknown as Array<{ guid: string; tag: string | null }>;
const tagByGuid = new Map(tagRows.map((r) => [r.guid, r.tag]));

db.close();

// ---------- 5. 组装 ----------
/** 下浮率合理区间：与 price-stats 的双闸同口径，越界说明配错了 */
const RATE_MIN = -0.05;
const RATE_MAX = 0.45;

let matched = 0;
let rateOk = 0;
const facts: Fact[] = [];

for (const w of wins) {
  const norm = normalizeTitle(w.title);
  const ctrl = norm ? ctrlByNorm.get(norm) : undefined;
  const buyer = norm ? buyerByNorm.get(norm) : undefined;

  let rate: number | null = null;
  if (ctrl && w.winPrice && ctrl.amount > 0) {
    const r = 1 - w.winPrice / ctrl.amount;
    // 越界的不丢弃事实行，只是不算 rate —— 排行/集中度不依赖 rate
    if (r >= RATE_MIN && r <= RATE_MAX) {
      rate = r;
      rateOk++;
    }
  }
  if (ctrl) matched++;

  facts.push({
    guid: w.guid,
    title: w.title,
    city: w.city,
    pubDate: (w.pubDate || '').slice(0, 10),
    type: typeOfTitle(w.title || ''),
    tag: tagByGuid.get(w.guid) ?? null,
    winner: w.winner,
    winPrice: w.winPrice,
    ctrl: ctrl?.amount ?? null,
    ctrlKind: ctrl?.kind ?? null,
    rate,
    buyer: buyer ?? null,
    bidderCount: null,
  });
}

// ---------- 6. 审计 ----------
const byType = new Map<string, number>();
const byCity = new Map<string, number>();
const byWinner = new Map<string, number>();
for (const f of facts) {
  byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
  if (f.city) byCity.set(f.city, (byCity.get(f.city) ?? 0) + 1);
  if (f.winner) byWinner.set(f.winner, (byWinner.get(f.winner) ?? 0) + 1);
}

console.log(`事实行 ${facts.length}（源胜出记录 ${wins.length}）`);
console.log(`  配到控制价 ${matched}（${((matched / facts.length) * 100).toFixed(1)}%），其中下浮率有效 ${rateOk}`);
console.log(`  配到招标人 ${facts.filter((f) => f.buyer).length}`);
console.log(`  不同中标单位 ${byWinner.size}，≥5 次 ${[...byWinner.values()].filter((n) => n >= 5).length}`);
const typeSum = [...byType.values()].reduce((a, b) => a + b, 0);
console.log(`  行业分类合计 ${typeSum}（应等于 ${facts.length}）`);
console.log('  行业分布 ' + [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}${n}`).join(' / '));

if (typeSum !== facts.length) {
  console.error('[断言失败] 行业分类合计与实际行数不一致');
  process.exit(1);
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: {
    wins: wins.length,
    ctrl: ctrlRows.length,
    buyer: buyerRows.length,
  },
  stats: {
    matchedCtrl: matched,
    rateOk,
    winners: byWinner.size,
    winners5: [...byWinner.values()].filter((n) => n >= 5).length,
  },
  facts,
};

if (DRY) {
  console.log(`\n（--dry 不写文件；预计 ${(JSON.stringify(payload).length / 1024).toFixed(0)} KB）`);
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
const text = JSON.stringify(payload);
writeFileSync(OUT, text, 'utf8');
console.log(`\n已写 ${OUT}（${(text.length / 1024).toFixed(0)} KB），${statSync(OUT).mtime.toISOString()}`);
