/**
 * 同步 standard_ref：清掉 JSON 里已不存在的旧条目，并建立「项目类型 → 标准」映射。
 *
 * 映射是按 category 推导的规则表——技术标是按项目类型写的，
 * 没有映射的话，109 条标准对具体一个项目来说是噪音。
 *
 * 用法：node --no-warnings src/sync-standard-map.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = 'data';
const json = JSON.parse(readFileSync(join(DATA, 'standards.json'), 'utf8')) as {
  standards: Array<{ code: string; category: string; tech_bid_use: string }>;
};

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

// 1) 清理旧条目——只限于手工维护的条目（category 不是「安徽地方」）。
//    踩过的坑：DB34 标准是从 db34_standard 批量导入的，不在 standards.json 里，
//    用「不在 JSON 里就删」会把 300+ 条地方标准一起删掉（已发生过两次）。
//    DB34 的清理归 db34 自己的流程管，这里不碰。
const keep = new Set(json.standards.map((s) => s.code));
const existing = db
  .prepare("SELECT code FROM standard_ref WHERE category <> '安徽地方'")
  .all() as Array<{ code: string }>;
const del = db.prepare('DELETE FROM standard_ref WHERE code = ?');
let removed = 0;
for (const r of existing) {
  if (!keep.has(r.code)) {
    del.run(r.code);
    console.log(`  删除旧条目：${r.code}`);
    removed++;
  }
}

// 2) 项目类型映射表
db.exec(`
CREATE TABLE IF NOT EXISTS standard_project (
  project_type TEXT NOT NULL,   -- 房建 / 市政 / 园林 / 水利 / 电力 / 光伏 / 智能化 / 老旧小区 / 装配式
  std_code     TEXT NOT NULL,
  PRIMARY KEY (project_type, std_code)
);
CREATE INDEX IF NOT EXISTS idx_sp_type ON standard_project(project_type);
`);

/** category → 适用项目类型。全部施工类项目都要带通用规范、安全、省内地方标准 */
const MAP: Record<string, string[]> = {
  通用规范: ['房建', '市政', '园林', '水利', '电力', '光伏', '智能化', '老旧小区', '装配式'],
  通用: ['房建', '市政', '园林', '水利', '电力', '光伏', '智能化', '老旧小区', '装配式'],
  安全: ['房建', '市政', '园林', '水利', '电力', '光伏', '智能化', '老旧小区', '装配式'],
  '房建·施工验收': ['房建', '老旧小区', '装配式'],
  '房建·专项': ['房建', '老旧小区', '装配式'],
  市政: ['市政'],
  电力: ['电力', '光伏'],
  光伏: ['光伏'],
  智能化: ['智能化', '房建'],
  水利: ['水利'],
  设计: ['房建', '市政', '老旧小区', '装配式'],
  安徽地方: ['房建', '市政', '园林', '水利', '电力', '光伏', '智能化', '老旧小区', '装配式'],
};

db.exec('DELETE FROM standard_project;');
const ins = db.prepare('INSERT OR IGNORE INTO standard_project (project_type, std_code) VALUES (?,?)');
let links = 0;
for (const s of json.standards) {
  for (const p of MAP[s.category] ?? []) {
    ins.run(p, s.code);
    links++;
  }
}

const stat = db
  .prepare(
    `SELECT project_type p, COUNT(*) n,
            SUM(CASE WHEN s.tech_bid_use='必备' THEN 1 ELSE 0 END) req
     FROM standard_project m JOIN standard_ref s ON s.code = m.std_code
     GROUP BY project_type ORDER BY n DESC`,
  )
  .all() as Array<{ p: string; n: number; req: number }>;
console.log(`\n清理旧条目 ${removed} 条；建立映射 ${links} 条`);
console.log('各项目类型可用标准数（必备数）：');
for (const r of stat) console.log(`  ${r.p.padEnd(8)} ${String(r.n).padStart(3)} 条（必备 ${r.req}）`);

const t = db.prepare('SELECT COUNT(*) n, SUM(verified) v FROM standard_ref').get() as { n: number; v: number };
console.log(`\nstandard_ref 共 ${t.n} 条，已交叉验证 ${t.v} 条（${((t.v / t.n) * 100).toFixed(0)}%）`);
db.close();
