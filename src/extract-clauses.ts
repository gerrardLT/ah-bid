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
        (SELECT COUNT(*) FROM announcement_clause WHERE qualification IS NOT NULL) AS qual`,
    )
    .get() as { total: number; done: number; qual: number };
  const pct = (a: number, b: number): string => (b ? ((a / b) * 100).toFixed(1) : '0.0');
  console.log('\n=== 全库覆盖 ===');
  console.log(`  招标公告 ${r.total}，已扫 ${r.done}（${pct(r.done, r.total)}%），抽到资质 ${r.qual}（${pct(r.qual, r.total)}%）`);
}
