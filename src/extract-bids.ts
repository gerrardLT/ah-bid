/**
 * 中标结果批量结构化提取（P1）。
 *
 * 输入：attachment 里所有「中标候选人信息表 / 评标情况一览表」PDF
 * 产出：bid_result 表 —— 中标人、中标价、项目负责人、工期、报价区间、置信度
 *
 * 用法：
 *   node --no-warnings src/extract-bids.ts            # 只统计待处理量
 *   node --no-warnings src/extract-bids.ts --all      # 全量
 */

import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { joinBids } from './join-bids.ts';

const DATA = 'data';
const JSON_BEGIN = '@@BID_JSON_BEGIN@@';
const JSON_END = '@@BID_JSON_END@@';

const ALL = process.argv.includes('--all');
const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const LIMIT = argOf('limit') ? Number(argOf('limit')) : 0;

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');
db.exec(`
CREATE TABLE IF NOT EXISTS bid_result (
  attach_guid       TEXT PRIMARY KEY,
  announcement_guid TEXT NOT NULL,
  winner            TEXT,
  winner_price      REAL,
  leader            TEXT,
  duration_days     TEXT,
  bidder_count      INTEGER,
  price_min         REAL,
  price_max         REAL,
  confidence        TEXT,
  pdf_path          TEXT,
  extracted_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bid_ann ON bid_result(announcement_guid);
`);

const rows = db
  .prepare(
    `SELECT t.attach_guid g, t.announcement_guid ag, t.local_path p
     FROM attachment t
     WHERE t.status='ok' AND t.local_path IS NOT NULL
       AND (t.filename LIKE '%中标候选人信息%' OR t.filename LIKE '%评标情况%')
       AND t.filename LIKE '%.pdf'
     ORDER BY t.size_bytes ASC`,
  )
  .all() as unknown as Array<{ g: string; ag: string; p: string }>;

const done = new Set(
  (db.prepare('SELECT attach_guid g FROM bid_result').all() as Array<{ g: string }>).map((r) => r.g),
);
const todo = rows.filter((r) => !done.has(r.g));
const batch = ALL ? todo : todo.slice(0, LIMIT || 5);

console.log(`候选表 PDF 共 ${rows.length} 份；已提取 ${done.size}；待处理 ${todo.length}；本次处理 ${batch.length}`);

const ins = db.prepare(`
  INSERT INTO bid_result (attach_guid, announcement_guid, winner, winner_price, leader,
    duration_days, bidder_count, price_min, price_max, confidence, pdf_path, extracted_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(attach_guid) DO UPDATE SET
    winner=excluded.winner, winner_price=excluded.winner_price, leader=excluded.leader,
    duration_days=excluded.duration_days, bidder_count=excluded.bidder_count,
    price_min=excluded.price_min, price_max=excluded.price_max,
    confidence=excluded.confidence, pdf_path=excluded.pdf_path, extracted_at=excluded.extracted_at`);

function runPython(abs: string): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn('python', ['src/extract_bid.py', abs], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => resolve({ error: `spawn 失败：${String(e)}` }));
    child.on('close', () => {
      const bi = out.indexOf(JSON_BEGIN);
      const ei = out.indexOf(JSON_END);
      if (bi < 0 || ei < bi) return resolve({ error: '未找到 JSON 边界标记', stderr: err.slice(-150) });
      try {
        resolve(JSON.parse(out.slice(bi + JSON_BEGIN.length, ei)));
      } catch (e) {
        resolve({ error: `JSON 解析失败：${String(e).slice(0, 80)}` });
      }
    });
  });
}

let ok = 0;
let failed = 0;
const high = { n: 0 };
const t0 = Date.now();

for (const [i, r] of batch.entries()) {
  const abs = join(DATA, r.p);
  const j = await runPython(abs);
  if (j.error) {
    console.log(`  [${i + 1}/${batch.length}] ✗ ${j.error}  ${r.p.slice(-46)}`);
    failed++;
    continue;
  }
  ins.run(
    r.g,
    r.ag,
    j.winner ?? null,
    j.winner_price ?? null,
    j.leader ?? null,
    j.duration_days ?? null,
    j.bidder_count ?? null,
    j.price_min ?? null,
    j.price_max ?? null,
    j.confidence ?? null,
    r.p,
    new Date().toISOString(),
  );
  ok++;
  if (j.confidence === 'high') high.n++;
  const tag = j.confidence === 'high' ? '✓中标人+价' : j.confidence === 'medium' ? '·部分' : '✗无数据';
  console.log(`  [${i + 1}/${batch.length}] ${tag}  ${r.p.slice(-50)}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n提取完成：成功 ${ok}，失败 ${failed}，高置信 ${high.n}；耗时 ${secs}s`);

// 批量跑完自动按公告合并：候选人信息表的中标人 + 评标表的报价。
// 这两份是同一公告下的两个独立附件，不合并就会留下大批“有中标人缺价格”。
if (ALL) {
  console.log('\n按公告合并中标人与报价…');
  const r = await joinBids({ db, log: (m) => console.log(m) });
  console.log(`合并：可合并 ${r.pending} 条，成功 ${r.joined}，未锚定 ${r.missed}`);
}
const stat = db.prepare('SELECT COUNT(*) n, SUM(winner_price) c FROM bid_result').get() as {
  n: number;
  c: number;
};
const w = db.prepare('SELECT COUNT(*) n FROM bid_result WHERE winner IS NOT NULL').get() as { n: number };
console.log(`库里累计：bid_result ${stat.n} 行，有中标人 ${w.n} 行`);
db.close();
