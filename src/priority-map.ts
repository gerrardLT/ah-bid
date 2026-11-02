/**
 * 给 standard_project 映射打优先级，解决「光伏清单前 16 条全是通用规范、
 * 真正的光伏标准排到第 17 条」的可用性问题。
 *
 * 分层规则：
 *   1 = 专业标准  —— 写这类技术标必须首先引的（如光伏项目的 GB 50794/50795）
 *   2 = 施工通用   —— 跨专业但施工类项目都躲不开的（质量/安全/施工组织设计/危大工程）
 *   3 = 间接相关   —— 结构类通用规范、设计规范等，按需引用
 *
 * 用法：node --no-warnings src/priority-map.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const DATA = 'data';

/** 施工通用必备：不管什么专业，写技术标都要引 */
const CORE_CODES = new Set([
  'GB 55032-2022', // 施工质量控制通用规范
  'GB 55034-2022', // 施工现场安全卫生与职业健康通用规范
  'GB 50300-2013', // 施工质量验收统一标准
  'GB/T 50502-2009', // 施工组织设计规范
  'JGJ 59-2011', // 安全检查标准
  'JGJ/T 46-2024', // 临时用电
  '住建部令第37号', // 危大工程管理规定
  '建办质〔2018〕31号', // 危大工程范围
]);

/** 专业标准：category 属于该专业领域 */
const PROFESSIONAL: Record<string, string[]> = {
  房建: ['房建·施工验收', '房建·专项'],
  老旧小区: ['房建·施工验收', '房建·专项'],
  装配式: ['房建·施工验收', '房建·专项'],
  市政: ['市政'],
  电力: ['电力'],
  光伏: ['光伏'],
  智能化: ['智能化'],
  水利: ['水利'],
  园林: ['市政'], // 园林类标准目前归在市政分类下
};

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

// 加列（已存在则跳过）
const cols = db.prepare("PRAGMA table_info(standard_project)").all() as Array<{ name: string }>;
if (!cols.some((c) => c.name === 'priority')) {
  db.exec('ALTER TABLE standard_project ADD COLUMN priority INTEGER NOT NULL DEFAULT 3');
}

const rows = db
  .prepare(
    `SELECT m.project_type p, m.std_code c, s.category cat, s.level lv
     FROM standard_project m JOIN standard_ref s ON s.code = m.std_code`,
  )
  .all() as Array<{ p: string; c: string; cat: string; lv: string }>;

const upd = db.prepare('UPDATE standard_project SET priority = ? WHERE project_type = ? AND std_code = ?');

const dist = new Map<string, { p1: number; p2: number; p3: number }>();
for (const r of rows) {
  let pr = 3;
  if (CORE_CODES.has(r.c)) pr = 2;
  else if (r.cat === '安徽地方') pr = 1; // DB34 已按专业关键词归过类
  else if ((PROFESSIONAL[r.p] ?? []).includes(r.cat)) pr = 1;
  else if (r.cat === '通用规范' && r.c === 'GB 55030-2022') pr = 2; // 防水对多数项目是必备
  upd.run(pr, r.p, r.c);

  const d = dist.get(r.p) ?? { p1: 0, p2: 0, p3: 0 };
  if (pr === 1) d.p1++;
  else if (pr === 2) d.p2++;
  else d.p3++;
  dist.set(r.p, d);
}

console.log('各项目类型标准分布（1=专业 / 2=施工通用 / 3=间接相关）：');
for (const [p, d] of [...dist.entries()].sort((a, b) => b[1].p1 - a[1].p1)) {
  console.log(`  ${p.padEnd(8)} 专业 ${String(d.p1).padStart(3)}  通用 ${d.p2}  相关 ${String(d.p3).padStart(3)}`);
}

console.log('\n=== 修正后的「光伏」清单前 12 条 ===');
for (const r of db
  .prepare(
    `SELECT s.code, s.name, s.tech_bid_use, m.priority
     FROM standard_project m JOIN standard_ref s ON s.code = m.std_code
     WHERE m.project_type='光伏'
     ORDER BY m.priority, CASE s.tech_bid_use WHEN '必备' THEN 0 WHEN '常用' THEN 1 ELSE 2 END, s.code
     LIMIT 12`,
  )
  .all() as Array<Record<string, string | number>>) {
  console.log(`  [P${r.priority}/${r.tech_bid_use}] ${String(r.code).padEnd(22)} ${String(r.name).slice(0, 34)}`);
}
db.close();
