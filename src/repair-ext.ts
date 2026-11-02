/**
 * 离线修复 attachment.ext，并顺带体检已下载文件的完整性。
 *
 * 为什么需要：
 * upsertAttachment 的 ON CONFLICT 早先不更新 ext，于是一条「先失败、后成功」的附件
 * 会长期留着失败时写入的空 ext。文件本身是对的，只有元数据说谎。
 *
 * 修复依据以磁盘上的真实字节为准（sniff），识别不出才退回站点声明的扩展名
 * ——大体积 XML 容器（宿州 .SZZF）没有二进制签名，只能靠声明名。
 *
 * 用法：
 *   node --no-warnings src/repair-ext.ts            # dry-run，只报告不改库
 *   node --no-warnings src/repair-ext.ts --write    # 真正写入
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { declaredExt, sniff } from './filetype.ts';

const DATA = 'data';
const write = process.argv.includes('--write');
const db = new DatabaseSync(join(DATA, 'index.db'));

const rows = db
  .prepare("SELECT attach_guid g, filename, ext, size_bytes sz, local_path p FROM attachment WHERE status='ok'")
  .all() as Array<{ g: string; filename: string; ext: string | null; sz: number | null; p: string | null }>;

const upd = db.prepare('UPDATE attachment SET ext = ? WHERE attach_guid = ?');

let changed = 0, already = 0, missing = 0, unresolvable = 0, sizeBad = 0, noPath = 0;
const sizeIssues: Array<{ p: string; db: number | null; disk: number | null }> = [];

for (const r of rows) {
  if (!r.p) {
    noPath++;
    continue;
  }
  const abs = join(DATA, r.p);
  if (!existsSync(abs)) {
    missing++;
    sizeIssues.push({ p: r.p, db: r.sz, disk: null });
    continue;
  }

  // 完整性体检：磁盘字节数必须等于记录值，否则说明下载被截断或事后被改过。
  const disk = statSync(abs).size;
  if (r.sz !== null && disk !== r.sz) {
    sizeBad++;
    sizeIssues.push({ p: r.p, db: r.sz, disk });
  }

  const fd = openSync(abs, 'r');
  const head = Buffer.alloc(6);
  const got = readSync(fd, head, 0, 6, 0);
  closeSync(fd);
  const sniffed = got > 0 ? sniff(head.subarray(0, got)) : undefined;
  const target = sniffed ?? declaredExt(r.filename);

  if (r.ext === target) {
    already++;
    continue;
  }
  changed++;
  if (target === '.bin') unresolvable++;
  if (write) upd.run(target, r.g);
  if (changed <= 20) console.log(`  ${r.ext || '(空)'} -> ${target}  ${r.p.slice(0, 68)}`);
}

console.log(`\n扫描 ok 行 ${rows.length}`);
console.log(`  ext 需修正 ${changed}（其中只能退回声明名 ${unresolvable}）| 已正确 ${already}`);
console.log(`  文件缺失 ${missing} | 字节数与记录不符 ${sizeBad} | 无 local_path ${noPath}`);
if (sizeIssues.length) {
  console.log('\n需要关注的完整性问题（未修改）：');
  for (const s of sizeIssues.slice(0, 10)) console.log(`  记录=${s.db} 磁盘=${s.disk}  ${s.p}`);
}
console.log(write ? '\n已写入。' : '\ndry-run，未写库；加 --write 生效。');
db.close();
