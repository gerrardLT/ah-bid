// 按存量分值重算 score_verified（不重跑 Python）
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/index.db');
const r = db
  .prepare(
    `UPDATE tender_doc SET score_verified = CASE
       WHEN score_technical IS NOT NULL AND (
         COALESCE(score_technical,0)+COALESCE(score_commercial,0)
         +COALESCE(score_price,0)+COALESCE(score_credit,0)
       ) BETWEEN 99 AND 101 THEN 1 ELSE 0 END`,
  )
  .run();
console.log(`已重算标记，影响行数 ${r.changes}`);
const s = db.prepare('SELECT COUNT(*) n, SUM(score_verified) v FROM tender_doc').get() as { n: number; v: number };
console.log(`tender_doc ${s.n} 行，分值已验证 ${s.v}（${((s.v / s.n) * 100).toFixed(1)}%）`);
db.close();
