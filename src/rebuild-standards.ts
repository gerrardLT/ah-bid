/**
 * 标准库全量重建流水线。
 *
 * 顺序：清理孤儿 → national JSON 导入 → DB34 并入 → 映射 → 优先级 → 强制分级
 *
 * 为什么要有这个脚本：标准来源有两个（data/standards.json 手工维护 + db34_standard 批量），
 * 之前用「不在 JSON 里就删」的逻辑清孤儿，把 381 条 DB34 标准一起删了（事故）。
 * 正确判据是：既不在 JSON、也不在 db34_standard，才是真孤儿。
 *
 * 用法：node --no-warnings src/rebuild-standards.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA = 'data';

const json = JSON.parse(readFileSync(join(DATA, 'standards.json'), 'utf8')) as {
  standards: Array<{ code: string; category: string; tech_bid_use: string }>;
};

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

// ---- 1) 清理孤儿：既不在 JSON、也不在 DB34 库 ----
const inJson = new Set(json.standards.map((s) => s.code));
const inDb34 = new Set(
  (db.prepare('SELECT code FROM db34_standard').all() as Array<{ code: string }>).map((r) => r.code),
);
const existing = db.prepare('SELECT code, name FROM standard_ref').all() as Array<{ code: string; name: string }>;
const delMap = db.prepare('DELETE FROM standard_project WHERE std_code = ?');
const delRef = db.prepare('DELETE FROM standard_ref WHERE code = ?');
const removed: string[] = [];
for (const r of existing) {
  if (!inJson.has(r.code) && !inDb34.has(r.code)) {
    delMap.run(r.code);
    delRef.run(r.code);
    removed.push(`${r.code} ${r.name}`);
  }
}
console.log(`清理孤儿 ${removed.length} 条（既不在 standards.json 也不在 db34_standard）`);
for (const r of removed) console.log(`  - ${r}`);
db.close();

// ---- 2) 依次跑各阶段 ----
// 顺序不能乱：sync-standard-map 会 DELETE 整张映射表再按 category 重建，
// 所以它必须在 import-db34-to-ref 之前跑——否则会把 DB34 按关键词精确算出的分类冲掉。
const steps: Array<[string, string]> = [
  ['导入国家标准清单', 'src/import-standards.ts'],
  ['按 category 重建映射（会清空映射表）', 'src/sync-standard-map.ts'],
  ['并入 DB34 并按关键词精确分类', 'src/import-db34-to-ref.ts'],
  ['优先级分层', 'src/priority-map.ts'],
  ['强制规范精确映射', 'src/map-mandatory.ts'],
  ['强制规范检查', 'src/mandatory-check.ts'],
];

for (const [label, script] of steps) {
  console.log(`\n=== ${label} ===`);
  const out = execFileSync('node', ['--no-warnings', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  // 只打印要点行，避免刷屏
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  const keep = lines.filter((l) =>
    /累计|并入|映射|全文强制|已验证|清理|删除旧条目|各项目类型|导入 \d+/.test(l),
  );
  console.log((keep.length ? keep.slice(-8) : lines.slice(-4)).join('\n'));
}

// ---- 3) 最终统计 ----
const db2 = new DatabaseSync(join(DATA, 'index.db'), { readOnly: true });
const t = db2.prepare('SELECT COUNT(*) n, SUM(verified) v FROM standard_ref').get() as { n: number; v: number };
const m = db2.prepare('SELECT COUNT(*) n, SUM(priority=1) p1, SUM(priority=2) p2 FROM standard_project').get() as {
  n: number;
  p1: number;
  p2: number;
};
const md = db2
  .prepare("SELECT COUNT(*) n FROM standard_ref WHERE mandatory_level='全文强制'")
  .get() as { n: number };

console.log('\n========== 最终状态 ==========');
console.log(`standard_ref      ${t.n} 条（已验证 ${t.v}，${((t.v / t.n) * 100).toFixed(0)}%）`);
console.log(`standard_project  ${m.n} 条映射（专业 ${m.p1} / 施工通用 ${m.p2}）`);
console.log(`全文强制规范      ${md.n} 条`);
db2.close();
