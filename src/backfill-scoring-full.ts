/**
 * 回填 scoring_item_full：用放宽截断（1200 字）的抽取器重抽「评标办法」章节。
 *
 * 为什么单独建表而不是改 scoring_item：
 *   scoring_item 是 tech-bid-scoring.ts 的既有输入，它按 200 字长度做过滤与展示；
 *   把原文放宽会改变它已产出的三份材料包。所以旧表保持 200 字不动，
 *   档位判断这类需要完整原文的消费者改用 scoring_item_full。
 *
 * 用法：
 *   node --no-warnings src/backfill-scoring-full.ts --limit=3     # 先试 3 份
 *   node --no-warnings src/backfill-scoring-full.ts               # 全量（已回填的跳过）
 *   node --no-warnings src/backfill-scoring-full.ts --redo        # 全部重抽
 *   node --no-warnings src/backfill-scoring-full.ts --from=500 --limit=500
 */

import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA = 'data';
const JSON_BEGIN = '@@TENDER_JSON_BEGIN@@';
const JSON_END = '@@TENDER_JSON_END@@';
/** 写进表的抽取器版本，将来换规则可据此只重抽旧版本 */
const EXTRACTOR_VER = 'full-1200-v1';
const TIMEOUT_MS = 180_000;

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const LIMIT = Number(argOf('limit') ?? 0);
const FROM = Number(argOf('from') ?? 0);
const REDO = process.argv.includes('--redo');

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');
db.exec(`
CREATE TABLE IF NOT EXISTS scoring_item_full (
  attach_guid   TEXT NOT NULL,
  page          INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  cells_json    TEXT NOT NULL,
  extractor_ver TEXT NOT NULL,
  PRIMARY KEY (attach_guid, page, seq)
);
CREATE INDEX IF NOT EXISTS idx_sif_guid ON scoring_item_full(attach_guid);
`);

const rows = db
  .prepare('SELECT attach_guid g, pdf_path p FROM tender_doc WHERE pdf_path IS NOT NULL ORDER BY pdf_path')
  .all() as Array<{ g: string; p: string }>;

const done = new Set(
  (
    db.prepare('SELECT DISTINCT attach_guid g FROM scoring_item_full').all() as Array<{ g: string }>
  ).map((r) => r.g),
);

const todo = REDO ? rows : rows.filter((r) => !done.has(r.g));
const batch = todo.slice(FROM, LIMIT ? FROM + LIMIT : undefined);

console.log(
  `招标文件 ${rows.length} 份；已回填 ${done.size}；待处理 ${todo.length}；本次处理 ${batch.length}`,
);

const del = db.prepare('DELETE FROM scoring_item_full WHERE attach_guid = ?');
const ins = db.prepare(
  'INSERT OR REPLACE INTO scoring_item_full (attach_guid, page, seq, cells_json, extractor_ver) VALUES (?,?,?,?,?)',
);

function runPython(abs: string): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn('python', ['src/extract_tender.py', abs, '--scoring-only'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ error: `超时（>${TIMEOUT_MS / 1000}s）` });
    }, TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: `spawn 失败：${String(e)}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const bi = out.indexOf(JSON_BEGIN);
      const ei = out.indexOf(JSON_END);
      if (bi < 0 || ei < bi) return resolve({ error: '未找到 JSON 边界', stderr: err.slice(-200) });
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
let cells = 0;
let longCells = 0;
const t0 = Date.now();

for (const [i, r] of batch.entries()) {
  const abs = join(DATA, r.p);
  if (!existsSync(abs)) {
    failed++;
    console.log(`  [${i + 1}/${batch.length}] 文件缺失 ${r.p}`);
    continue;
  }
  const j = await runPython(abs);
  if (j.error) {
    failed++;
    console.log(`  [${i + 1}/${batch.length}] ✗ ${j.error}  ${r.p.slice(-46)}`);
    continue;
  }

  del.run(r.g);
  let seq = 0;
  const seen = new Set<string>();
  for (const t of j.scoring_tables ?? []) {
    for (const rowCells of t.rows ?? []) {
      const key = JSON.stringify(rowCells);
      if (seen.has(key)) continue;
      seen.add(key);
      ins.run(r.g, t.page ?? 0, seq++, key, EXTRACTOR_VER);
      cells++;
      if (key.length > 200) longCells++;
    }
  }
  ok++;
  if ((i + 1) % 20 === 0 || i + 1 === batch.length) {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `  [${i + 1}/${batch.length}] 成功 ${ok} 失败 ${failed} 写入 ${cells} 行（>200字 ${longCells}）耗时 ${secs}s`,
    );
  }
}

const stat = db.prepare(
  'SELECT COUNT(*) n, COALESCE(SUM(length(cells_json) > 200),0) long FROM scoring_item_full',
).get() as { n: number; long: number };

console.log(`\n完成：成功 ${ok}，失败 ${failed}，本次写入 ${cells} 行（>200 字 ${longCells}）`);
console.log(`scoring_item_full 累计 ${stat.n} 行，其中 >200 字 ${stat.long} 行`);
db.close();
