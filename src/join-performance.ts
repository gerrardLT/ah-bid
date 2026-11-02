/**
 * 把履约记录的「合同金额」回填到 bid_result 缺中标价的记录。
 *
 * 逻辑：一条履约记录 = 某主体 × 某项目 的合同。
 * 只有当 **主体名匹配（中标人）且项目名匹配（公告标题）** 时才回填——
 * 单靠项目名不够：同一项目可能有监理、施工、设计多个主体，金额完全不同。
 *
 * 幂等：只处理 winner_price 仍为空的记录。回填后 confidence 标 high-from-perf，
 * 与「从评标表抽出来的 high」区分开，便于追溯来源。
 *
 * 用法：node --no-warnings src/join-performance.ts [--dry]
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const DATA = 'data';
const DRY = process.argv.includes('--dry');

const norm = (s: string | null): string =>
  (s ?? '').replace(/[\s　]/g, '').replace(/[（）()【】\[\]]/g, '');

/** 项目名匹配键：取前 14 字（去掉标点），足够定位又不会因后缀差异失配 */
const projectKey = (s: string | null): string => norm(s).slice(0, 14);

/** 主体名匹配：取前 6 字互相包含（履约表与公告的中标人写法常有细微差异） */
const subjectKey = (s: string | null): string => norm(s).slice(0, 6);

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

const perf = db
  .prepare(
    `SELECT subject_name, project_name, contract_amount
     FROM performance_record
     WHERE contract_amount > 0 AND subject_name IS NOT NULL AND project_name IS NOT NULL`,
  )
  .all() as Array<{ subject_name: string; project_name: string; contract_amount: number }>;

// 索引：项目键 → 履约记录列表
const byProject = new Map<string, Array<{ s: string; amount: number }>>();
for (const p of perf) {
  const k = projectKey(p.project_name);
  if (k.length < 6) continue;
  const list = byProject.get(k) ?? [];
  list.push({ s: subjectKey(p.subject_name), amount: p.contract_amount });
  byProject.set(k, list);
}

const targets = db
  .prepare(
    `SELECT b.attach_guid g, b.winner w, a.title t
     FROM bid_result b JOIN announcement a ON a.guid = b.announcement_guid
     WHERE b.winner IS NOT NULL AND b.winner_price IS NULL`,
  )
  .all() as Array<{ g: string; w: string; t: string }>;

console.log(`履约记录 ${perf.length} 条（${byProject.size} 个项目键）；待回填 ${targets.length} 条${DRY ? '（dry-run）' : ''}`);

const upd = db.prepare(
  `UPDATE bid_result SET winner_price = ?, confidence = 'high-from-perf' WHERE attach_guid = ?`,
);

let filled = 0;
let ambiguous = 0;
let noMatch = 0;

for (const r of targets) {
  const titleKey = norm(r.t);
  const wkey = subjectKey(r.w);

  // 公告标题里找包含的履约项目键（标题带“招标公告/中标结果公示”等后缀，所以用包含匹配）
  let best: { amount: number } | null = null;
  let candidates = 0;
  for (const [k, list] of byProject) {
    if (k.length < 6 || !titleKey.includes(k)) continue;
    for (const item of list) {
      if (item.s !== wkey) continue;
      candidates++;
      best = { amount: item.amount };
    }
  }

  if (candidates === 0) {
    noMatch++;
    continue;
  }
  if (candidates > 1) {
    // 同一项目同一主体多条履约记录（多标段/多次递交）：取第一条但标出来
    ambiguous++;
  }
  if (DRY) {
    console.log(`  [dry] ${r.w.slice(0, 16)} = ${best!.amount}  ← ${r.t.slice(0, 30)}`);
    filled++;
    continue;
  }
  upd.run(best!.amount, r.g);
  filled++;
  if (filled <= 10) console.log(`  ✓ ${r.w.slice(0, 16)} = ${best!.amount}  ← ${r.t.slice(0, 28)}`);
}

console.log(`\n回填 ${filled} 条（其中同项目同主体多条 ${ambiguous}），无匹配 ${noMatch}`);
const s = db.prepare(
  "SELECT COUNT(*) n, SUM(CASE WHEN winner_price IS NOT NULL THEN 1 ELSE 0 END) p FROM bid_result",
).get() as { n: number; p: number };
const bySrc = db
  .prepare('SELECT COALESCE(confidence, \'?\') c, COUNT(*) n FROM bid_result WHERE winner_price IS NOT NULL GROUP BY c')
  .all() as Array<{ c: string; n: number }>;
console.log(`bid_result ${s.n} 行：有中标价 ${s.p}（来源：${bySrc.map((x) => `${x.c}=${x.n}`).join('  ')}）`);
db.close();
