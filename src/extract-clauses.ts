/**
 * 资格条件抽取器：读 announcement.body_text，写 announcement_clause。
 *
 * 为什么独立成表：与 deadline 同一个理由 —— 不动 350MB 的 announcement，
 * 回填 8,494 行要重写 34MB 记录。
 *
 * 用法：
 *   node --no-warnings src/extract-clauses.ts --dry
 *   node --no-warnings src/extract-clauses.ts              # 增量
 *   node --no-warnings src/extract-clauses.ts --force      # 全量重抽
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { parseClauses } from './lib/clauses.ts';
import { parsePerfReq } from './lib/perf-req.ts';

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

const db = new DatabaseSync(join('data', 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

db.exec(`
CREATE TABLE IF NOT EXISTS announcement_clause (
  announcement_guid TEXT PRIMARY KEY,
  qualification     TEXT,      -- 资质要求原文，如「建筑工程施工总承包一级」
  builder           TEXT,      -- 建造师，如「一级建造师（建筑工程）」
  performance       TEXT,      -- 业绩门槛，如「近3年1个类似业绩」
  joint_venture     INTEGER,   -- 0=不接受 1=接受 NULL=没提
  qual_text         TEXT,      -- 资格段原文 ≤300 字，供人工复核
  confidence        TEXT,      -- high | medium | low | none
  reason            TEXT,      -- null=抽到了；no_section / no_field_matched / ...
  body_hash         TEXT,
  extracted_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clause_jv ON announcement_clause(joint_venture);

-- 业绩五要素（独立表：单行 JSON 存不下并列条件，也无法按金额/年限索引）
CREATE TABLE IF NOT EXISTS announcement_perf (
  announcement_guid TEXT PRIMARY KEY,
  years       INTEGER,
  from_date   TEXT,
  cnt         INTEGER,
  min_amount  REAL,
  scope       TEXT,
  kind        TEXT,
  proof       TEXT,
  scale       TEXT,
  evidence    TEXT,
  notice      TEXT,      -- 无门槛 | 见招标文件 | NULL(有实质门槛 或 没找到业绩句)
  confidence  TEXT,
  reason      TEXT,
  extracted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perf_amount ON announcement_perf(min_amount);
CREATE INDEX IF NOT EXISTS idx_perf_notice ON announcement_perf(notice);
`);

const sql = `
  SELECT a.guid, a.body_text AS body
  FROM announcement a
  LEFT JOIN announcement_clause c ON c.announcement_guid = a.guid
  WHERE a.bulletin_nature = '1'
    ${FORCE ? '' : 'AND c.announcement_guid IS NULL'}
  ORDER BY a.pub_date DESC
`;
const rows = db.prepare(sql).all() as unknown as Array<{ guid: string; body: string | null }>;

console.log(`待处理 ${rows.length} 条（${FORCE ? '全量重抽' : '增量'}）`);
if (rows.length === 0) {
  report();
  db.close();
  process.exit(0);
}

const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16);
const now = new Date().toISOString();
const results = rows.map((r) => ({ ...r, hit: parseClauses(r.body ?? ''), h: hash(r.body ?? '') }));

if (DRY) {
  console.log('（--dry，不写库）\n');
} else {
  const ins = db.prepare(`
    INSERT INTO announcement_clause
      (announcement_guid, qualification, builder, performance, joint_venture,
       qual_text, confidence, reason, body_hash, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(announcement_guid) DO UPDATE SET
      qualification = excluded.qualification,
      builder       = excluded.builder,
      performance   = excluded.performance,
      joint_venture = excluded.joint_venture,
      qual_text     = excluded.qual_text,
      confidence    = excluded.confidence,
      reason        = excluded.reason,
      body_hash     = excluded.body_hash,
      extracted_at  = excluded.extracted_at
  `);
  db.exec('BEGIN');
  try {
    for (const r of results) {
      const h = r.hit;
      ins.run(r.guid, h.qualification, h.builder, h.performance, h.jointVenture,
        h.qualText, h.confidence, h.reason, r.h, now);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`已写入 ${results.length} 行\n`);

  // 业绩五要素：独立事务 —— 这一段失败不能回滚上面已写好的资质行
  const insPerf = db.prepare(`
    INSERT INTO announcement_perf
      (announcement_guid, years, from_date, cnt, min_amount, scope, kind, proof, scale,
       evidence, notice, confidence, reason, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(announcement_guid) DO UPDATE SET
      years = excluded.years, from_date = excluded.from_date, cnt = excluded.cnt,
      min_amount = excluded.min_amount, scope = excluded.scope, kind = excluded.kind,
      proof = excluded.proof, scale = excluded.scale, evidence = excluded.evidence,
      notice = excluded.notice, confidence = excluded.confidence, reason = excluded.reason,
      extracted_at = excluded.extracted_at
  `);
  db.exec('BEGIN');
  try {
    for (const r of results) {
      const p = parsePerfReq(r.body ?? '');
      insPerf.run(r.guid, p.years, p.fromDate, p.cnt, p.minAmount, p.scope, p.kind,
        p.proof, p.scale, p.evidence, p.notice, p.confidence, p.reason, now);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`业绩五要素已写入 ${results.length} 行\n`);
}

// ---------- 审计 ----------
const cnt = (f: (r: (typeof results)[number]) => string): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const r of results) {
    const k = f(r);
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
};

const withQual = results.filter((r) => r.hit.qualification).length;
const withBld = results.filter((r) => r.hit.builder).length;
const withPerf = results.filter((r) => r.hit.performance).length;
const jvNo = results.filter((r) => r.hit.jointVenture === 0).length;
const jvYes = results.filter((r) => r.hit.jointVenture === 1).length;

console.log('=== 本次结果 ===');
console.log(`  资质要求   ${withQual} / ${results.length}（${((withQual / results.length) * 100).toFixed(1)}%）`);
console.log(`  建造师     ${withBld}（${((withBld / results.length) * 100).toFixed(1)}%）`);
console.log(`  业绩门槛   ${withPerf}（${((withPerf / results.length) * 100).toFixed(1)}%）`);
console.log(`  联合体     不接受 ${jvNo} / 接受 ${jvYes} / 没提 ${results.length - jvNo - jvYes}`);
console.log(`  置信度     ${JSON.stringify(cnt((r) => r.hit.confidence))}`);
console.log(`  未抽到原因 ${JSON.stringify(cnt((r) => r.hit.reason ?? '-'))}\n`);

// 抽查：优先看 high 的
const samples = [...results].filter((r) => r.hit.confidence === 'high').slice(0, 8);
console.log('=== 抽查样例（confidence=high，前 8）===');
for (const r of samples) {
  console.log(`  【${r.hit.qualification ?? '资质未抽到'}】`);
  console.log(`   ${r.hit.builder ?? '—'} | ${r.hit.performance ?? '—'} | 联合体 ${r.hit.jointVenture ?? '未提'}`);
}

report();
db.close();

function report(): void {
  const r = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM announcement WHERE bulletin_nature='1') AS total,
        (SELECT COUNT(*) FROM announcement_clause) AS done,
        (SELECT COUNT(*) FROM announcement_clause WHERE qualification IS NOT NULL) AS qual,
        (SELECT COUNT(*) FROM announcement_perf) AS perf,
        (SELECT COUNT(*) FROM announcement_perf WHERE notice='无门槛') AS noReq,
        (SELECT COUNT(*) FROM announcement_perf WHERE notice='见招标文件') AS defer,
        (SELECT COUNT(*) FROM announcement_perf WHERE notice IS NULL AND reason IS NULL) AS real,
        (SELECT COUNT(*) FROM announcement_perf WHERE min_amount IS NOT NULL) AS amount`,
    )
    .get() as {
    total: number; done: number; qual: number; perf: number;
    noReq: number; defer: number; real: number; amount: number;
  };
  const pct = (a: number, b: number): string => (b ? ((a / b) * 100).toFixed(1) : '0.0');
  console.log('\n=== 全库覆盖 ===');
  console.log(`  招标公告 ${r.total}，已扫 ${r.done}（${pct(r.done, r.total)}%），抽到资质 ${r.qual}（${pct(r.qual, r.total)}%）`);
  console.log(`  业绩：已扫 ${r.perf} / 明确无门槛 ${r.noReq} / 见招标文件 ${r.defer} / 有实质门槛 ${r.real} / 有金额 ${r.amount}`);
}
