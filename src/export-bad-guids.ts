// 导出评标办法抽坏的 attach_guid 清单（供 --redo-guids 定向重跑）
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const db = new DatabaseSync('data/index.db', { readOnly: true });
const guids = db
  .prepare(`SELECT attach_guid g FROM tender_doc WHERE evaluation_method LIKE '%规定的方法%'`)
  .all() as Array<{ g: string }>;
db.close();
writeFileSync('data/_method_bad_guids.txt', guids.map((r) => r.g).join('\n'), 'utf8');
console.log(`已导出 ${guids.length} 个 guid`);
