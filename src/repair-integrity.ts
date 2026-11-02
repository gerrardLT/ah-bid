/**
 * 修复"本地字节数与记录不符"或"路径被两条附件共用"的附件。
 *
 * 成因（已实证）：旧版重名后缀取 attachGuid 前 6 位，而站点给的 attachGuid 是递增数字
 * （56004839… / 56004883…），前六位大量相同，两份不同附件落在同一路径上互相覆盖。
 * 现在的写入器改用完整 guid 指纹且保证不覆盖，但历史错配需要在这里解除。
 *
 * 修复方式：标回 status='failed' 并清空 local_path，让 --retry-failed 重下。
 * 清空 local_path 是必要的：写入器靠它判定“这个文件归我”，
 * 不清就会把共享路径当成自己的文件继续覆盖。
 *
 * 用法：
 *   node --no-warnings src/repair-integrity.ts            # dry-run
 *   node --no-warnings src/repair-integrity.ts --write
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DATA = 'data';
const write = process.argv.includes('--write');
const db = new DatabaseSync(join(DATA, 'index.db'));

const rows = db
  .prepare(
    `SELECT t.attach_guid g, t.announcement_guid ag, t.filename, t.size_bytes sz, t.local_path p, a.city
     FROM attachment t JOIN announcement a ON a.guid = t.announcement_guid
     WHERE t.status='ok'`,
  )
  .all() as Array<{ g: string; ag: string; filename: string; sz: number | null; p: string | null; city: string }>;

const mark = db.prepare("UPDATE attachment SET status='failed', reason=?, local_path=NULL, sha256=NULL WHERE attach_guid=?");

// 路径共享：同一 local_path 被多条附件占用，内容只可能属于其中一条，其余的记录都是错的。
const shared = new Map<string, string[]>();
for (const r of rows) {
  if (!r.p) continue;
  const list = shared.get(r.p) ?? [];
  list.push(r.g);
  shared.set(r.p, list);
}
const sharedGuids = new Set<string>();
for (const [, gs] of shared) if (gs.length > 1) for (const g of gs) sharedGuids.add(g);

const bad: typeof rows = [];
const missing: typeof rows = [];
for (const r of rows) {
  if (!r.p) continue;
  const abs = join(DATA, r.p);
  if (!existsSync(abs)) {
    missing.push(r);
    continue;
  }
  const disk = statSync(abs).size;
  if (r.sz !== null && disk !== r.sz) bad.push(r);
  else if (sharedGuids.has(r.g)) bad.push(r);
}

const byCity = new Map<string, number>();
for (const r of bad) byCity.set(r.city, (byCity.get(r.city) ?? 0) + 1);

console.log(`扫描 ok 行 ${rows.length}`);
console.log(`  字节数与记录不符：${bad.length}`);
console.log(`  其中路径被多条附件共用：${[...sharedGuids].length}`);
console.log(`  文件缺失：${missing.length}`);
for (const [c, n] of [...byCity.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${c}: ${n}`);

const REASON = '本地字节数与记录不符或路径冲突（历史同名覆盖），已标记重新下载';
const affected = [...bad, ...missing];
if (write) {
  for (const r of affected) mark.run(REASON, r.g);
  console.log(`\n已把 ${affected.length} 行标回 failed。接着跑：`);
  const cities = [...new Set(affected.map((r) => r.city))];
  console.log(`  node --no-warnings src/run-resume.ts   # 或直接对 ${cities.join('、')} 跑 --retry-failed`);
} else {
  console.log('\ndry-run，未改库；加 --write 生效。');
  for (const r of bad.slice(0, 8))
    console.log(`  记录=${r.sz} 磁盘=${statSync(join(DATA, r.p!)).size}  ${String(r.p).slice(-50)}`);
}
db.close();
