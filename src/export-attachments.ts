/**
 * 导出附件清单为 CSV（Excel 可直接打开）。
 *
 * 用法：
 *   node src/export-attachments.ts                          # 默认输出 data/附件清单.csv
 *   node src/export-attachments.ts --out=data/附件.csv --only-ok
 *
 * 输出带 UTF-8 BOM，Excel 打开中文不乱码。
 */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { TAG_LABELS, BULLETIN_NATURES, type Tag } from './config.ts';

interface Args {
  db: string;
  out: string;
  onlyOk: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, d: string) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  return {
    db: get('db', 'data/index.db'),
    out: get('out', 'data/附件清单.csv'),
    onlyOk: argv.includes('--only-ok'),
  };
}

const args = parseArgs(process.argv.slice(2));
const db = new DatabaseSync(args.db);

interface Row {
  pubDate: string;
  city: string;
  district: string;
  tag: string;
  nature: string;
  title: string;
  filename: string;
  sizeBytes: number | null;
  localPath: string | null;
  status: string;
  ext: string;
  originUrl: string | null;
  annGuid: string;
  attachGuid: string;
  downloadedAt: string;
}

const where = args.onlyOk ? "WHERE t.status = 'ok'" : '';
const rows = db
  .prepare(
    `SELECT a.pub_date AS pubDate, a.city, a.district,
            a.primary_tag AS tag, a.bulletin_nature AS nature, a.title,
            t.filename, t.size_bytes AS sizeBytes, t.local_path AS localPath,
            t.status, t.ext, a.origin_url AS originUrl,
            t.announcement_guid AS annGuid, t.attach_guid AS attachGuid,
            t.downloaded_at AS downloadedAt
     FROM attachment t
     JOIN announcement a ON a.guid = t.announcement_guid
     ${where}
     ORDER BY a.pub_date DESC, a.city, t.filename`,
  )
  .all() as unknown as Row[];

if (rows.length === 0) {
  console.log('附件表为空，先跑 src/attach.ts 下载。');
  db.close();
  process.exit(0);
}

const header = [
  '序号',
  '发布日期',
  '城市',
  '区县',
  '业务类别',
  '公告类型',
  '公告标题',
  '附件文件名',
  '扩展名',
  '大小(MB)',
  '状态',
  '本地相对路径',
  '原文链接',
  '公告GUID',
  '附件GUID',
];

const esc = (v: unknown) => {
  const s = String(v ?? '');
  return `"${s.replace(/"/g, '""')}"`;
};

const lines: string[] = [header.map(esc).join(',')];
let seq = 0;
let totalBytes = 0;

for (const r of rows) {
  seq++;
  const mb = r.sizeBytes ? (r.sizeBytes / 1048576).toFixed(2) : '';
  if (r.sizeBytes) totalBytes += r.sizeBytes;
  lines.push(
    [
      seq,
      r.pubDate,
      r.city,
      r.district,
      TAG_LABELS[r.tag as Tag] ?? r.tag ?? '',
      BULLETIN_NATURES[r.nature] ?? r.nature,
      r.title,
      r.filename,
      r.ext,
      mb,
      r.status,
      r.localPath ?? '',
      r.originUrl ?? '',
      r.annGuid,
      r.attachGuid,
    ]
      .map(esc)
      .join(','),
  );
}

mkdirSync(dirname(args.out), { recursive: true });
// BOM + CRLF：Excel 打开不乱码、不粘行
writeFileSync(args.out, '\ufeff' + lines.join('\r\n'), 'utf8');

// ---- 控制台摘要 ----
console.log(`已导出 ${rows.length} 条到 ${args.out}`);
console.log(`合计 ${(totalBytes / 1073741824).toFixed(2)} GB\n`);

const byStatus = db
  .prepare('SELECT status, COUNT(*) n, ROUND(COALESCE(SUM(size_bytes),0)/1048576.0,1) mb FROM attachment GROUP BY status')
  .all() as Array<{ status: string; n: number; mb: number }>;
console.log('按状态：');
for (const s of byStatus) console.log(`  ${s.status.padEnd(10)} ${String(s.n).padStart(5)} 个  ${s.mb} MB`);

const byTag = db
  .prepare(
    `SELECT a.primary_tag AS t, COUNT(*) n, ROUND(COALESCE(SUM(t.size_bytes),0)/1048576.0,1) mb
     FROM attachment t JOIN announcement a ON a.guid = t.announcement_guid
     GROUP BY a.primary_tag ORDER BY n DESC`,
  )
  .all() as Array<{ t: string; n: number; mb: number }>;
console.log('\n按业务类别：');
for (const s of byTag) console.log(`  ${(TAG_LABELS[s.t as Tag] ?? s.t).padEnd(6)} ${String(s.n).padStart(5)} 个  ${s.mb} MB`);

const byCity = db
  .prepare(
    `SELECT a.city, COUNT(*) n, ROUND(COALESCE(SUM(t.size_bytes),0)/1048576.0,1) mb
     FROM attachment t JOIN announcement a ON a.guid = t.announcement_guid
     GROUP BY a.city ORDER BY n DESC`,
  )
  .all() as Array<{ city: string; n: number; mb: number }>;
console.log('\n按城市：');
for (const s of byCity) console.log(`  ${s.city.padEnd(7)} ${String(s.n).padStart(5)} 个  ${s.mb} MB`);

// 顺带核一下磁盘实际占用，防止库里有记录但文件丢了
let missing = 0;
let onDisk = 0;
for (const r of rows) {
  if (!r.localPath) continue;
  const p = join('data', r.localPath);
  if (existsSync(p)) onDisk += statSync(p).size;
  else missing++;
}
console.log(`\n磁盘校验：实际存在 ${((onDisk / 1073741824) * 1).toFixed(2)} GB，缺失文件 ${missing} 个`);

db.close();
