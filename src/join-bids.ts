/**
 * 把「中标候选人信息表」的中标人与「评标情况一览表」的报价合并。
 *
 * 背景：这两份是同一公告下的两个独立附件——
 *   候选人信息表有「第一中标候选人」但没有报价；
 *   评标情况一览表有全部投标人报价但没有「第一中标候选人」字段。
 * 当成两条独立记录处理会得到大批 medium（有中标人缺价格），
 * 所以必须在公告级做一次合并：用已知中标人名称在评标表里做价格锚定。
 *
 * 同时作为模块导出（joinBids），供 extract-bids.ts 在批量跑完后自动调用。
 * 也可单独运行：
 *   node --no-warnings src/join-bids.ts [--limit=N]
 */

import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA = 'data';
const JSON_BEGIN = '@@BID_JSON_BEGIN@@';
const JSON_END = '@@BID_JSON_END@@';

export interface JoinResult {
  /** 可合并的公告数（有中标人无价 + 同公告下有带报价的评标表） */
  pending: number;
  joined: number;
  missed: number;
}

function runPython(abs: string, winner: string): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn('python', ['src/extract_bid.py', abs, `--winner=${winner}`], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', (e) => resolve({ error: String(e) }));
    child.on('close', () => {
      const bi = out.indexOf(JSON_BEGIN);
      const ei = out.indexOf(JSON_END);
      if (bi < 0 || ei < bi) return resolve({ error: '未找到 JSON' });
      try {
        resolve(JSON.parse(out.slice(bi + JSON_BEGIN.length, ei)));
      } catch {
        resolve({ error: 'JSON 解析失败' });
      }
    });
  });
}

/**
 * 按公告合并中标人与报价。幂等：只处理仍是「有中标人、无中标价」的记录。
 *
 * @param opts.db    复用调用方的连接（批量流程里避免同进程重复开库）
 * @param opts.limit 只处理前 N 条，用于抽样验证
 * @param opts.log   进度输出（批量流程里可以静默）
 */
export async function joinBids(
  opts: { db?: DatabaseSync; limit?: number; log?: (msg: string) => void } = {},
): Promise<JoinResult> {
  const log = opts.log ?? (() => {});
  const ownsDb = !opts.db;
  const db = opts.db ?? new DatabaseSync(join(DATA, 'index.db'));
  db.exec('PRAGMA busy_timeout = 30000;');
  try {
    const pending = db
      .prepare(
        `SELECT a.attach_guid g, a.announcement_guid ag, a.winner w
         FROM bid_result a
         WHERE a.winner IS NOT NULL AND a.winner_price IS NULL
           AND EXISTS (
             SELECT 1 FROM bid_result b
             WHERE b.announcement_guid = a.announcement_guid
               AND b.attach_guid <> a.attach_guid AND b.price_min IS NOT NULL
           )
         ORDER BY a.announcement_guid`,
      )
      .all() as Array<{ g: string; ag: string; w: string }>;

    const batch = opts.limit ? pending.slice(0, opts.limit) : pending;
    if (!batch.length) return { pending: pending.length, joined: 0, missed: 0 };

    const evalPathOf = db.prepare(
      `SELECT pdf_path p FROM bid_result
       WHERE announcement_guid = ? AND attach_guid <> ? AND price_min IS NOT NULL
       ORDER BY bidder_count DESC LIMIT 1`,
    );
    const upd = db.prepare(
      `UPDATE bid_result SET winner_price = ?, confidence = 'high' WHERE attach_guid = ?`,
    );

    let joined = 0;
    let missed = 0;
    for (const [i, r] of batch.entries()) {
      const ev = evalPathOf.get(r.ag, r.g) as { p: string } | undefined;
      if (!ev) {
        missed++;
        continue;
      }
      const j = await runPython(join(DATA, ev.p), r.w);
      if (j.error || j.winner_price == null) {
        missed++;
        log(`  [${i + 1}/${batch.length}] ✗ ${j.error ?? '未锚定到价格'}  ${r.w.slice(0, 18)}`);
        continue;
      }
      upd.run(j.winner_price, r.g);
      joined++;
      log(`  [${i + 1}/${batch.length}] ✓ ${r.w.slice(0, 16)} = ${j.winner_price}`);
    }
    return { pending: pending.length, joined, missed };
  } finally {
    if (ownsDb) db.close();
  }
}

// ---- CLI 入口：仅当直接运行本文件时 ----
const entry = process.argv[1];
const isMain = entry ? import.meta.url === pathToFileURL(entry).href : false;

if (isMain) {
  const hit = process.argv.find((a) => a.startsWith('--limit='));
  const limit = hit ? Number(hit.slice('--limit='.length)) : 0;
  console.log('开始按公告合并中标人与报价…');
  joinBids({ limit: limit || undefined, log: (m) => console.log(m) })
    .then((r) => {
      console.log(`\n可合并公告 ${r.pending} 条，成功 ${r.joined}，未锚定 ${r.missed}`);
      const db = new DatabaseSync(join(DATA, 'index.db'), { readOnly: true });
      const s = db
        .prepare(
          "SELECT COUNT(*) n, SUM(CASE WHEN winner_price IS NOT NULL THEN 1 ELSE 0 END) p FROM bid_result",
        )
        .get() as { n: number; p: number };
      console.log(`bid_result ${s.n} 行：有中标价 ${s.p}`);
      db.close();
    })
    .catch((e) => {
      console.error(`合并失败：${String(e)}`);
      process.exit(1);
    });
}
