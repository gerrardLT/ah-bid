/**
 * 控制价单独入库：把 tender_doc.money_json 解析成结构化表。
 *
 * 为什么单独建表：现在控制价只在算下浮率时临时读 JSON，无法直接查询、
 * 无法与中标价做长期对比分析、也没法按城市/类型统计限价水平。
 *
 * money_json 结构（实测）：
 *   [{"label":"最高投标限价：\n4008792.20 元","yuan":4008792.2,"raw":"..."}, ...]
 * 有的文件有多条（最高投标限价 + 招标控制价重复记录），取金额最大且带「最高投标限价」标签的。
 *
 * 用法：node --no-warnings src/control-price.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { collectPairs } from './lib/price-stats.ts';

const DATA = 'data';
const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

db.exec(`
CREATE TABLE IF NOT EXISTS tender_control_price (
  attach_guid       TEXT PRIMARY KEY,
  announcement_guid TEXT,
  title             TEXT,
  city              TEXT,
  amount            REAL,     -- 元
  amount_raw        TEXT,     -- 原文串，便于核对
  label             TEXT,     -- 原始标签（可能很脏）
  price_kind        TEXT,     -- 归一化：限价 / 估算价 / 预算 / 其他
  source_field      TEXT,     -- 固定为 money_json，便于以后扩展别的来源
  extracted_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tcp_city ON tender_control_price(city);
`);
// 补列 + 建索引（顺序不能反：旧表还没 price_kind 列时，建索引会因「no such column」直接报错）
try {
  db.exec('ALTER TABLE tender_control_price ADD COLUMN price_kind TEXT');
} catch {
  /* 列已存在 */
}
db.exec('CREATE INDEX IF NOT EXISTS idx_tcp_kind ON tender_control_price(price_kind)');

/**
 * 标签归一化——这三种语义不同，不能混做一谈：
 *   最高投标限价 / 招标控制价 → 「限价」：投标不能超过它，是真正的上限
 *   合同估算价                → 「估算」：招标前拍的价，不等于上限
 *   预算金额                  → 「预算」：采购预算，语义接近但主体不同
 * 混在一起算均值会失真（实测 1,812 条里 514 条是「合同估算价」）。
 */
const kindOf = (label: string): string => {
  const t = label.replace(/\s+/g, '');
  if (t.includes('最高投标限价') || t.includes('招标控制价') || t.includes('最高限价')) return '限价';
  if (t.includes('合同估算价')) return '估算';
  if (t.includes('预算金额')) return '预算';
  return '其他';
};

const rows = db
  .prepare(
    `SELECT d.attach_guid g, d.announcement_guid ag, d.money_json, a.title, a.city
     FROM tender_doc d JOIN announcement a ON a.guid = d.announcement_guid
     WHERE d.money_json IS NOT NULL AND d.money_json <> '[]'`,
  )
  .all() as Array<{ g: string; ag: string; money_json: string; title: string; city: string | null }>;

const ins = db.prepare(`
INSERT INTO tender_control_price (attach_guid, announcement_guid, title, city, amount, amount_raw, label, price_kind, source_field, extracted_at)
VALUES (?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(attach_guid) DO UPDATE SET
  amount=excluded.amount, amount_raw=excluded.amount_raw, label=excluded.label,
  price_kind=excluded.price_kind, extracted_at=excluded.extracted_at`);

const now = new Date().toISOString();
let ok = 0;
let bad = 0;
const byLabel = new Map<string, number>();

for (const r of rows) {
  let arr: Array<{ label?: string; yuan?: number; raw?: string }>;
  try {
    arr = JSON.parse(r.money_json) as typeof arr;
  } catch {
    bad++;
    continue;
  }
  if (!Array.isArray(arr) || !arr.length) {
    bad++;
    continue;
  }
  // 优先「最高投标限价」标签，且金额 > 1000（排除明显错值）
  const cands = arr.filter((x) => typeof x.yuan === 'number' && x.yuan > 1000);
  if (!cands.length) {
    bad++;
    continue;
  }
  const preferred = cands.filter((x) => (x.label ?? '').includes('最高投标限价'));
  const pick = (preferred.length ? preferred : cands).sort((a, b) => (b.yuan ?? 0) - (a.yuan ?? 0))[0];
  const rawLabel = pick.label ?? '';
  const labelKey = kindOf(rawLabel);

  ins.run(r.g, r.ag, r.title, r.city, pick.yuan ?? null, (pick.raw ?? rawLabel).slice(0, 200), rawLabel.slice(0, 40), labelKey, 'money_json', now);
  ok++;
  byLabel.set(labelKey, (byLabel.get(labelKey) ?? 0) + 1);
}

console.log(`解析 ${rows.length} 份招标文件的 money_json：成功 ${ok}，无法解析 ${bad}`);
console.log('\n按价格类型（归一化后）：');
for (const [k, n] of [...byLabel.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(8)} ${n}`);

const stat = db.prepare("SELECT COUNT(*) n, ROUND(SUM(amount)/100000000,2) yi FROM tender_control_price WHERE price_kind='限价'").get() as {
  n: number;
  yi: number;
};
console.log(`\ntender_control_price 总计 ${(db.prepare('SELECT COUNT(*) n FROM tender_control_price').get() as { n: number }).n} 条`);
console.log(`  其中真限价（可用于下浮率）${stat.n} 条，合计 ${stat.yi} 亿元`);

console.log('\n按城市（限价样本量 Top 8）：');
for (const r of db
  .prepare(
    `SELECT city, COUNT(*) n, ROUND(AVG(amount)/10000) avg_wan, ROUND(SUM(amount)/100000000,2) yi
     FROM tender_control_price WHERE city IS NOT NULL AND price_kind='限价' GROUP BY city ORDER BY n DESC LIMIT 8`,
  )
  .all() as Array<{ city: string; n: number; avg_wan: number; yi: number }>) {
  console.log(`  ${String(r.city).padEnd(8)} ${String(r.n).padStart(4)} 条  均限价 ${String(r.avg_wan).padStart(6)} 万  合计 ${r.yi} 亿`);
}

// 能与中标价配对的真实数量。
// 旧版用「前 14 字 LIKE」粗匹配，既与 price-benchmark 的全等口径不一致，
// 也会把「XX 项目」配到「XX 项目监理」上——这正是 99.3% 下浮率事故的成因。
const cal = collectPairs(db, 'limit');
console.log(
  `\n真限价中可与中标公告配对的：${cal.pairs.length} 条` +
    `（全等匹配；多标段丢弃 ${cal.droppedCtrl}，双闸剔除 ${cal.droppedGate}）`,
);
db.close();
