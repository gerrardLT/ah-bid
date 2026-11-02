/**
 * 从公告正文提取中标人 + 中标价（补齐 bid_result 的覆盖缺口）。
 *
 * 背景：bid_result 只有 780 条记录、181 条中标价，因为它的来源是附件
 * （中标候选人信息表 + 评标情况一览表）。但全库 nature=2/3 的中标类公告
 * 有 14,084 个，其中**有附件的只有 27 个（0.2%）**——中标信息在公告正文里，不在附件里。
 *
 * 实测：正文含「中标候选人」的 2,787 个公告，能提取出 602 条「中标人 + 中标金额」，
 * 样本为「安徽省新路建设工程集团 = 26343685.80」这种干净数据。
 *
 * 用法：node --no-warnings src/extract-bids-from-body.ts [--dry] [--out=path.md]
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const DATA = 'data';
const DRY = process.argv.includes('--dry');

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

db.exec(`
CREATE TABLE IF NOT EXISTS bid_body_result (
  announcement_guid TEXT PRIMARY KEY,
  title             TEXT,
  city              TEXT,
  pub_date          TEXT,
  winner            TEXT,
  winner_price      REAL,     -- 元
  price_raw         TEXT,     -- 原文金额串（保留原样，便于核对）
  price_unit        TEXT,     -- 元 / 万元
  confidence        TEXT,     -- high（人+价都齐）/ medium（只有其一）
  evidence          TEXT,     -- 提取依据片段
  extracted_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bbr_winner ON bid_body_result(winner);
`);

const flat = (s: string): string =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&ensp;|&nbsp;|&emsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 中标人：优先「第一中标候选人」，其次「中标人/中标单位/成交供应商」。
 * 必须带机构后缀，否则会把「中标候选人公示」里的形容词误抓成公司名。
 */
const NAME_RE =
  /(?:第一中标候选人|中标候选人|中标人|中标单位|成交供应商|成交人|中标企业)\s*(?:名称)?\s*[:：（(]?\s*([^\s，,。；;、：:()（）]{4,30}?(?:公司|中心|设计院|研究院|厂|集团|事务所|总队|局))/;

/**
 * 金额：锚定「中标价/中标金额」后 40 字内的首个数字，必须带单位。
 *
 * 为什么要用 [\u4e00-\u9fa5\W]{0,40} 跳过：实测有多种写法——
 *   中标价（元/费率）：1500000.00 元
 *   中标价：人民币壹佰陆拾捌万贰仟陆佰元整（1682600.00 元）   ← 大写在前、数字在后
 *   中标金额：捌亿陆仟零柒拾壹万捌仟零柒拾元陆角贰分（860718070.62 元）
 * 不能从「中标价」后直接取数字，必须先跳过括号/大写那一段。
 *
 * 必须带「元/万元」单位并做量级校验，否则会抳到「代理服务费金额：89128 元」
 * 与「合同金额：3100000.00 元」（那是历史业绩，不是本项目中标价）。
 */
const PRICE_RE =
  /(?:中标价|中标金额|中标价格|成交金额|成交价|中标总价)\s*(?:[（(][^）)]{0,12}[）)])?\s*(?:为)?\s*[:：]?\s*(?:人民币)?[^\d]{0,40}?([0-9][0-9,，.]{3,})\s*(万元|元)/;

/** 排除上下文：这几类写法的数字不是本项目中标价 */
const NOT_BID = /代理服务费|招标代理|代理费|服务费金额|合同金额|工程款|预算金额|结算金额|业绩/;

const rows = db
  .prepare(
    `SELECT guid, title, city, pub_date, body_text
     FROM announcement
     WHERE bulletin_nature IN ('2','3') AND body_text LIKE '%中标%'`,
  )
  .all() as Array<{ guid: string; title: string; city: string | null; pub_date: string | null; body_text: string }>;

const ins = db.prepare(`
INSERT INTO bid_body_result (announcement_guid, title, city, pub_date, winner, winner_price, price_raw, price_unit, confidence, evidence, extracted_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(announcement_guid) DO UPDATE SET
  winner=excluded.winner, winner_price=excluded.winner_price, price_raw=excluded.price_raw,
  price_unit=excluded.price_unit, confidence=excluded.confidence, evidence=excluded.evidence,
  extracted_at=excluded.extracted_at`);

const now = new Date().toISOString();
let high = 0;
let medium = 0;
let skipped = 0;
const samples: string[] = [];

for (const r of rows) {
  const t = flat(r.body_text);
  const nm = NAME_RE.exec(t);
  const pm = PRICE_RE.exec(t);
  const winner = nm?.[1]?.trim() ?? null;
  // 排除接在「代理服务费/业绩合同金额」后面的数字
  const before = pm ? t.slice(Math.max(0, pm.index - 24), pm.index) : '';
  const priceOk = pm && !NOT_BID.test(before);
  const priceRaw = priceOk ? pm![1].replace(/[,，]/g, '') : null;
  const unit = priceOk ? (pm![2] ?? null) : null;

  if (!winner && !priceRaw) {
    skipped++;
    continue;
  }

  let price: number | null = null;
  if (priceRaw) {
    const v = Number(priceRaw);
    // 量级校验：工程中标价极少低于 1 万元，低于则必是误抓
    if (Number.isFinite(v) && v >= 10000) {
      price = unit === '万元' ? v * 10000 : v;
    }
  }

  const conf = winner && price ? 'high' : 'medium';
  if (!DRY) {
    ins.run(
      r.guid,
      r.title,
      r.city,
      r.pub_date,
      winner,
      price,
      priceRaw,
      unit,
      conf,
      t.slice(Math.max(0, (nm?.index ?? pm?.index ?? 0) - 40), (nm?.index ?? pm?.index ?? 0) + 80),
      now,
    );
  }
  if (conf === 'high') {
    high++;
    if (samples.length < 8) samples.push(`${winner?.slice(0, 20)} = ${price?.toLocaleString()} 元`);
  } else medium++;
}

console.log(`扫描 ${rows.length} 个中标类公告（正文含「中标」）`);
console.log(`  两者齐全（high）  ${high}`);
console.log(`  只有其一（medium） ${medium}`);
console.log(`  无法提取          ${skipped}${DRY ? '   [dry-run 未写库]' : ''}`);
if (samples.length) {
  console.log('\n样本：');
  for (const s of samples) console.log(`  ${s}`);
}

if (!DRY) {
  const t = db.prepare('SELECT COUNT(*) n, COUNT(winner) w, COUNT(winner_price) p FROM bid_body_result').get() as {
    n: number;
    w: number;
    p: number;
  };
  console.log(`\nbid_body_result：${t.n} 条 / 有中标人 ${t.w} / 有中标价 ${t.p}`);
  const old = db.prepare('SELECT COUNT(*) n FROM bid_result WHERE winner_price IS NOT NULL').get() as { n: number };
  console.log(`bid_result（附件来源）：有中标价 ${old.n}`);
  console.log(`合计可用的中标价记录：${old.n + t.p}`);
}
db.close();
