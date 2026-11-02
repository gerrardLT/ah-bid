/**
 * 把 data/standards.json 的规范清单导入 standard_ref 表。
 *
 * 清单是手工维护的（路线 A），不是爬来的——因为实测招标文件里的规范引用
 * 稀疏且语境错位（详见项目记录），不值得从 PDF 里挖。
 *
 * 用法：node --no-warnings src/import-standards.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = 'data';

interface Std {
  code: string;
  name: string;
  level: string;
  category: string;
  status: string;
  verified: boolean;
  sources: number;
  tech_bid_use: string;
  note: string;
}

const json = JSON.parse(readFileSync(join(DATA, 'standards.json'), 'utf8')) as {
  _meta: Record<string, string>;
  standards: Std[];
};

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');
db.exec(`
CREATE TABLE IF NOT EXISTS standard_ref (
  code         TEXT PRIMARY KEY,   -- 标准号（含版本年份），主键
  name         TEXT NOT NULL,
  level        TEXT NOT NULL,      -- 国家标准 / 行业标准 / 地方标准
  category     TEXT NOT NULL,      -- 通用/安全/房建·施工验收/市政/电力/光伏/设计
  status       TEXT NOT NULL,      -- 现行 / 废止 / 即将实施
  verified     INTEGER NOT NULL,   -- 1 = 已交叉验证（≥2 独立来源一致）
  sources      INTEGER NOT NULL,   -- 交叉验证来源数
  tech_bid_use TEXT NOT NULL,      -- 必备 / 常用 / 参考
  note         TEXT,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_std_cat ON standard_ref(category);
CREATE INDEX IF NOT EXISTS idx_std_use ON standard_ref(tech_bid_use);
`);

const up = db.prepare(`
INSERT INTO standard_ref (code, name, level, category, status, verified, sources, tech_bid_use, note, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(code) DO UPDATE SET
  name=excluded.name, level=excluded.level, category=excluded.category, status=excluded.status,
  verified=excluded.verified, sources=excluded.sources, tech_bid_use=excluded.tech_bid_use,
  note=excluded.note, updated_at=excluded.updated_at`);

const now = new Date().toISOString();
let n = 0;
for (const s of json.standards) {
  up.run(s.code, s.name, s.level, s.category, s.status, s.verified ? 1 : 0, s.sources, s.tech_bid_use, s.note, now);
  n++;
}

const stat = db
  .prepare(
    `SELECT category, COUNT(*) n, SUM(verified) v FROM standard_ref GROUP BY category ORDER BY n DESC`,
  )
  .all() as Array<{ category: string; n: number; v: number }>;
console.log(`导入 ${n} 条标准`);
for (const r of stat) console.log(`  ${r.category.padEnd(12)} ${String(r.n).padStart(3)} 条（已验证 ${r.v}）`);

const t = db.prepare('SELECT COUNT(*) n, SUM(verified) v FROM standard_ref').get() as { n: number; v: number };
console.log(`\nstandard_ref 累计 ${t.n} 条，已交叉验证 ${t.v} 条（${((t.v / t.n) * 100).toFixed(0)}%）`);
db.close();
