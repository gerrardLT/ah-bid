/**
 * 强制性规范分层与检查。
 *
 * 背景：2021-2022 年 GB 55xxx 通用规范体系建立后，旧标准（GB 50xxx / JGJ 等）
 * 中的强制性条文被废止 133 本，强制力统一收敛到 GB 55xxx（全文强制）。
 *
 * 所以技术标里的「强制性条文」不再是"某标准第几条"，而是"必须引这些 GB 55xxx"。
 * 引了 GB 50300 却没引 GB 55032，属于漏引强制性规范——这是评委最容易挑的硬伤。
 *
 * 本脚本：
 *   1. 给 standard_ref 加 mandatory_level 字段
 *   2. GB 55xxx 标「全文强制」，其余标「配套技术标准」
 *   3. 输出各项目类型的「必引强制规范清单」，可直接用作检查表
 *
 * 用法：node --no-warnings src/mandatory-check.ts [项目类型]
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const DATA = 'data';

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

const cols = new Set((db.prepare('PRAGMA table_info(standard_ref)').all() as Array<{ name: string }>).map((c) => c.name));
if (!cols.has('mandatory_level')) {
  db.exec("ALTER TABLE standard_ref ADD COLUMN mandatory_level TEXT DEFAULT ''");
}

// GB 55xxx 全部全文强制
db.exec("UPDATE standard_ref SET mandatory_level = '全文强制' WHERE code LIKE 'GB 55%'");
// 其余为配套技术标准（其原有强条已废止或即将废止）
db.exec("UPDATE standard_ref SET mandatory_level = '配套技术标准' WHERE code NOT LIKE 'GB 55%'");

const total = db.prepare("SELECT COUNT(*) n FROM standard_ref WHERE mandatory_level='全文强制'").get() as { n: number };

// 按项目类型输出必引清单
const types = ['房建', '市政', '园林', '水利', '电力', '光伏', '智能化', '老旧小区', '装配式'];
const pick = process.argv[2];
const wanted = pick ? [pick] : types;

console.log(`全文强制规范共 ${total.n} 条\n`);
for (const t of wanted) {
  const rows = db
    .prepare(
      `SELECT s.code, s.name FROM standard_project m JOIN standard_ref s ON s.code = m.std_code
       WHERE m.project_type = ? AND s.mandatory_level = '全文强制'
       ORDER BY s.code`,
    )
    .all(t) as Array<{ code: string; name: string }>;
  console.log(`=== ${t}：${rows.length} 条全文强制规范（缺一条就算漏引）===`);
  for (const r of rows) console.log(`  ${r.code.padEnd(16)} ${r.name}`);
  console.log('');
}

// 未映射到任何项目的强制规范（说明映射有缺口）
const orphan = db
  .prepare(
    `SELECT code, name FROM standard_ref
     WHERE mandatory_level='全文强制' AND code NOT IN (SELECT std_code FROM standard_project)
     ORDER BY code`,
  )
  .all() as Array<{ code: string; name: string }>;
if (orphan.length) {
  console.log(`⚠ 未映射到任何项目类型的强制规范 ${orphan.length} 条：`);
  for (const r of orphan) console.log(`  ${r.code.padEnd(16)} ${r.name}`);
}

const stat = db
  .prepare(
    `SELECT mandatory_level l, COUNT(*) n FROM standard_ref GROUP BY l ORDER BY n DESC`,
  )
  .all() as Array<{ l: string; n: number }>;
console.log('\n库里强制等级分布：');
for (const r of stat) console.log(`  ${(r.l || '(未标)').padEnd(12)} ${r.n} 条`);
db.close();
