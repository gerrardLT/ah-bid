/**
 * 回填 announcement_attachment 关联表的历史数据。
 *
 * 关联表是后加的：此前只有 attachment.announcement_guid（首个写入者）能表达归属，
 * 兄弟公告拿到的是空的。这里把已有 attachment 行的归属补成关联，
 * 让历史数据也能享受多对多语义。
 *
 * 幂等：INSERT OR IGNORE，(announcement_guid, attach_guid) 是主键。
 *
 * 用法：
 *   node --no-warnings src/backfill-links.ts            # 只报告将要插入多少
 *   node --no-warnings src/backfill-links.ts --write
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const DATA = 'data';
const write = process.argv.includes('--write');
const db = new DatabaseSync(join(DATA, 'index.db'));

// 建表语句与 db.ts 保持一致；这里独立执行一次，避免为了回填去构造完整 IndexDb。
db.exec(`
CREATE TABLE IF NOT EXISTS announcement_attachment (
  announcement_guid TEXT NOT NULL,
  attach_guid       TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  PRIMARY KEY (announcement_guid, attach_guid)
);
CREATE INDEX IF NOT EXISTS idx_annatt_att ON announcement_attachment(attach_guid);
`);

const one = (sql: string) => db.prepare(sql).get() as { n: number };

const att = one('SELECT COUNT(*) n FROM attachment').n;
const before = one('SELECT COUNT(*) n FROM announcement_attachment').n;
const pend = one(`
  SELECT COUNT(*) n FROM attachment a
  WHERE NOT EXISTS (
    SELECT 1 FROM announcement_attachment l
    WHERE l.announcement_guid = a.announcement_guid AND l.attach_guid = a.attach_guid
  )`).n;

console.log(`attachment 行 ${att} 条；关联表现有 ${before} 条；待补 ${pend} 条`);

if (write) {
  db.exec(`
    INSERT OR IGNORE INTO announcement_attachment (announcement_guid, attach_guid, recorded_at)
    SELECT announcement_guid, attach_guid, COALESCE(downloaded_at, datetime('now'))
    FROM attachment
  `);
  const after = one('SELECT COUNT(*) n FROM announcement_attachment').n;
  console.log(`已回填，关联表现在 ${after} 条（+${after - before}）`);
} else {
  console.log('dry-run，未改库；加 --write 生效。');
}
db.close();
