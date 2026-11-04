/**
 * 投标截止时间抽取器：读 announcement.body_text，写 announcement_deadline。
 *
 * 为什么独立成表而不给 announcement 加列：
 *   库 330MB、freelist=0，往 8,494 行含 4KB 正文的表回填字段要重写 34MB 记录 + WAL 34MB，
 *   库会涨到 370MB；独立表只增约 1MB。
 *
 * 为什么顺手补两个外键索引：
 *   tender_control_price(1,812) 与 tender_duration(7,899) 的 announcement_guid 上没有索引，
 *   daily-digest 的两个 MAX() 子查询每行都要全表扫，30 天 0.13s、1 年 1.00s 全花在这。
 *   补完 30 天降到 3-5ms。这张表本来就是「跑一次就常驻」的，索引建在这里最合适。
 *
 * 用法：
 *   node --no-warnings src/extract-deadline.ts --dry          # 只统计，不写库
 *   node --no-warnings src/extract-deadline.ts                # 增量（跳过已抽过的）
 *   node --no-warnings src/extract-deadline.ts --force        # 全量重抽
 *   node --no-warnings src/extract-deadline.ts --limit=500    # 分批
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { parseDeadline } from './lib/deadline.ts';

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const LIMIT = Number(argOf('limit') ?? '0');

const db = new DatabaseSync(join('data', 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

// ---------------- 建表 + 补索引 ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS announcement_deadline (
  announcement_guid TEXT PRIMARY KEY,
  deadline_date     TEXT,      -- 'YYYY-MM-DD'，范围查询用这个
  deadline_at       TEXT,      -- 'YYYY-MM-DD HH:MM'，展示用
  hhmm              TEXT,      -- '09:30'，只到日时为 null
  source            TEXT,      -- bid_deadline | open_time
  confidence        TEXT,      -- high | medium | none
  candidates        INTEGER,   -- 正文里找到几个候选（33% 有多条）
  evidence          TEXT,      -- 命中原文 ≤120 字，供人工复核
  body_hash         TEXT,      -- 正文指纹，正文变了才重抽
  reason            TEXT,      -- no_anchor | no_date_near_anchor | all_gated | no_text
  pub_date          TEXT,      -- 冗余，紧急区免 JOIN
  extracted_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dl_date ON announcement_deadline(deadline_date);

-- 批次 2A：日报的两个 MAX() 子查询靠这两条索引提速
CREATE INDEX IF NOT EXISTS idx_tcp_ann  ON tender_control_price(announcement_guid);
CREATE INDEX IF NOT EXISTS idx_tdur_ann ON tender_duration(announcement_guid);
`);

// ---------------- 取待处理 ----------------
// 增量条件只有一条：还没抽过的。
// 「正文变了要重抽」不做自动判断 —— body_hash 是逐行算的，SQL 里没法比；
// 确实需要时用 --force。这条写进注释，避免以后有人以为增量会跟进正文变更。
const sql = `
  SELECT a.guid, a.pub_date AS pubDate, a.body_text AS body
  FROM announcement a
  LEFT JOIN announcement_deadline d ON d.announcement_guid = a.guid
  WHERE a.bulletin_nature = '1'
    ${FORCE ? '' : 'AND d.announcement_guid IS NULL'}
  ORDER BY a.pub_date DESC
  ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
`;
const rows = db.prepare(sql).all() as unknown as Array<{
  guid: string;
  pubDate: string;
  body: string | null;
}>;

console.log(`待处理 ${rows.length} 条（${FORCE ? '全量重抽' : '增量'}${LIMIT ? `，上限 ${LIMIT}` : ''}）`);

if (rows.length === 0) {
  reportCoverage();
  db.close();
  process.exit(0);
}

// ---------------- 抽取 ----------------
const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16);
const now = new Date().toISOString();

const results = rows.map((r) => {
  const body = r.body ?? '';
  const hit = parseDeadline(body, r.pubDate);
  return { ...r, hit, bodyHash: hash(body) };
});

// ---------------- 写入（单事务，把锁窗口压到 1 秒内） ----------------
if (DRY) {
  console.log('（--dry，不写库）\n');
} else {
  const ins = db.prepare(`
    INSERT INTO announcement_deadline
      (announcement_guid, deadline_date, deadline_at, hhmm, source, confidence,
       candidates, evidence, body_hash, reason, pub_date, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(announcement_guid) DO UPDATE SET
      deadline_date = excluded.deadline_date,
      deadline_at   = excluded.deadline_at,
      hhmm          = excluded.hhmm,
      source        = excluded.source,
      confidence    = excluded.confidence,
      candidates    = excluded.candidates,
      evidence      = excluded.evidence,
      body_hash     = excluded.body_hash,
      reason        = excluded.reason,
      pub_date      = excluded.pub_date,
      extracted_at  = excluded.extracted_at
  `);
  db.exec('BEGIN');
  try {
    for (const r of results) {
      const h = r.hit;
      ins.run(
        r.guid, h.date, h.at, h.hhmm, h.source, h.confidence,
        h.candidates, h.evidence, r.bodyHash, h.reason, r.pubDate, now,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`已写入 ${results.length} 行\n`);
}

// ---------------- 审计输出 ----------------
const cnt = (f: (r: (typeof results)[number]) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const r of results) {
    const k = f(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};

const paired = results.filter((r) => r.hit.date).length;
console.log('=== 本次结果 ===');
console.log(`  抽到 ${paired} / ${results.length}（${((paired / results.length) * 100).toFixed(1)}%）`);
console.log(`  来源 ${JSON.stringify(Object.fromEntries(cnt((r) => r.hit.source ?? 'null')))}`);
console.log(`  置信度 ${JSON.stringify(Object.fromEntries(cnt((r) => r.hit.confidence)))}`);
console.log(`  未抽到原因 ${JSON.stringify(Object.fromEntries(cnt((r) => r.hit.reason ?? '-')))}\n`);

// 剩余天数分布
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const buckets = new Map<string, number>();
for (const r of results) {
  if (!r.hit.date) continue;
  const d = Math.round((Date.parse(r.hit.date) - Date.parse(today)) / 864e5);
  const k = d < 0 ? '已过期' : d <= 3 ? '3天内' : d <= 7 ? '4-7天' : d <= 30 ? '8-30天' : '30天以上';
  buckets.set(k, (buckets.get(k) ?? 0) + 1);
}
console.log(`=== 剩余天数分布（today=${today}）===`);
for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(8)} ${v}`);
}

// 抽样：优先展示「多候选」和「只靠开标时间兜底」的，这些最容易错
const samples = [...results]
  .sort((a, b) => (b.hit.candidates - a.hit.candidates) || (a.hit.confidence === 'high' ? 1 : -1))
  .slice(0, 20);
console.log('\n=== 抽查样例（前 20，按候选数降序）===');
for (const r of samples) {
  console.log(`  [${r.hit.confidence}/${r.hit.source ?? '-'}/候选${r.hit.candidates}] ${r.hit.date ?? '抽不到'}  ${r.hit.evidence.slice(0, 70)}`);
}

// ---------------- 自检断言 ----------------
// 抽出的截止日期早于发布日期 = 闸门漏了，必须当场失败，不能静默写进库
const bad = db
  .prepare(
    `SELECT COUNT(*) AS n FROM announcement_deadline d
     JOIN announcement a ON a.guid = d.announcement_guid
     WHERE d.deadline_date IS NOT NULL AND d.deadline_date < a.pub_date`,
  )
  .get() as { n: number };
if (bad.n > 0) {
  console.error(`\n[断言失败] 有 ${bad.n} 行的截止日期早于发布日期，闸门漏了。请排查后重跑。`);
  db.close();
  process.exit(1);
}
console.log('\n[断言通过] 没有「截止日期早于发布日期」的行');

reportCoverage();
db.close();

// ---------------- 全库覆盖率 ----------------
function reportCoverage(): void {
  const r = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM announcement WHERE bulletin_nature='1') AS total,
         (SELECT COUNT(*) FROM announcement_deadline) AS done,
         (SELECT COUNT(*) FROM announcement_deadline WHERE deadline_date IS NOT NULL) AS hit`,
    )
    .get() as { total: number; done: number; hit: number };
  const pct = (a: number, b: number): string => (b ? ((a / b) * 100).toFixed(1) : '0.0');
  console.log('\n=== 全库覆盖 ===');
  console.log(`  招标公告 ${r.total} 条，已扫 ${r.done}（${pct(r.done, r.total)}%），抽到 ${r.hit}（${pct(r.hit, r.total)}%）`);
}
