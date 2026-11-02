/**
 * 按专业内容精确映射 GB 55xxx 通用规范——修正「所有通用规范映射到所有项目类型」的粗放做法。
 *
 * 问题：category='通用规范' 统一映射到 9 个项目类型后，写房建技术标的清单里
 * 出现了《城市道路交通工程项目规范》《生活垃圾处理处置工程项目规范》，
 * 明显不属于房建范围。强制规范清单一旦混入无关条目，检查表就失去意义。
 *
 * 只有 GB 55032（施工质量）和 GB 55034（施工安全）是真正跨所有施工专业的，
 * 其余按内容归属。
 *
 * 用法：node --no-warnings src/map-mandatory.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const DATA = 'data';

/** GB 55xxx → 适用项目类型。未列出的（如市政专属的燃气/供热/垃圾）按内容精确指定 */
const MAP: Record<string, string[]> = {
  // 结构类：跨房建/市政/装配式，但光伏/水利/园林基本用不到
  'GB 55001-2021': ['房建', '市政', '老旧小区', '装配式'],
  'GB 55002-2021': ['房建', '市政', '老旧小区', '装配式'],
  'GB 55003-2021': ['房建', '市政', '老旧小区', '装配式'],
  'GB 55004-2021': ['房建', '市政', '装配式'],
  'GB 55005-2021': ['房建', '老旧小区'],
  'GB 55006-2021': ['房建', '市政', '装配式'],
  'GB 55007-2021': ['房建', '老旧小区', '装配式'],
  'GB 55008-2021': ['房建', '市政', '老旧小区', '装配式'],
  // 市政专属
  'GB 55009-2021': ['市政'],
  'GB 55010-2021': ['市政'],
  'GB 55011-2021': ['市政'],
  'GB 55012-2021': ['市政'],
  'GB 55013-2021': ['市政'],
  'GB 55014-2021': ['市政', '园林'],
  // 房建专属
  'GB 55015-2021': ['房建', '老旧小区'],
  'GB 55016-2021': ['房建'],
  'GB 55020-2021': ['房建', '市政'],
  'GB 55022-2021': ['房建', '老旧小区'],
  'GB 55031-2022': ['房建', '老旧小区'],
  'GB 55036-2022': ['房建', '市政', '智能化'],
  'GB 55037-2022': ['房建', '老旧小区', '装配式'],
  // 防水：房建与市政都涉及
  'GB 55030-2022': ['房建', '市政', '老旧小区'],
  // 施工类：真正全专业通用
  'GB 55032-2022': ['房建', '市政', '园林', '水利', '电力', '光伏', '智能化', '老旧小区', '装配式'],
  'GB 55034-2022': ['房建', '市政', '园林', '水利', '电力', '光伏', '智能化', '老旧小区', '装配式'],
};

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

// 先清掉 GB 55xxx 的全部旧映射，再按本表重建
db.exec("DELETE FROM standard_project WHERE std_code LIKE 'GB 55%'");

const ins = db.prepare('INSERT OR IGNORE INTO standard_project (project_type, std_code, priority) VALUES (?,?,?)');
let n = 0;
for (const [code, types] of Object.entries(MAP)) {
  for (const t of types) {
    // GB 55032 / 55034 属施工通用（priority=2），其余强制规范为专业相关（priority=1）
    const pr = code === 'GB 55032-2022' || code === 'GB 55034-2022' ? 2 : 1;
    ins.run(t, code, pr);
    n++;
  }
}

// 校验：是否有通用规范没被映射（说明 MAP 漏了）
const orphan = db
  .prepare(
    `SELECT code, name FROM standard_ref
     WHERE code LIKE 'GB 55%' AND code NOT IN (SELECT std_code FROM standard_project)`,
  )
  .all() as Array<{ code: string; name: string }>;

console.log(`重建 GB 55xxx 映射 ${n} 条`);
if (orphan.length) {
  console.log(`⚠ 未映射 ${orphan.length} 条：`);
  for (const r of orphan) console.log(`  ${r.code} ${r.name}`);
} else {
  console.log('全部 24 条通用规范都已映射到具体专业');
}

console.log('\n各项目类型的强制规范数量：');
for (const r of db
  .prepare(
    `SELECT m.project_type p, COUNT(*) n FROM standard_project m
     JOIN standard_ref s ON s.code = m.std_code
     WHERE s.code LIKE 'GB 55%' GROUP BY p ORDER BY n DESC`,
  )
  .all() as Array<{ p: string; n: number }>) {
  console.log(`  ${r.p.padEnd(8)} ${r.n} 条`);
}
db.close();
