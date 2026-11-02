/**
 * 本地检索命令。抓完之后日常用这个查。
 *
 * 用法：
 *   node src/query.ts --tag=power                 # 看电力类
 *   node src/query.ts --tag=pv --city=合肥        # 按城市筛
 *   node src/query.ts --keyword=储能 --from=2026-06-01
 *   node src/query.ts --tag=building --format=csv --out=data/building.csv
 *   node src/query.ts --stats                     # 只看统计
 *
 * 注意：tags 是 JSON 数组，一个公告可能同时属于多个类别（如"光伏电站升压站"）。
 * --tag 用包含匹配，能查全；统计默认按 primary_tag 去重，避免重复计数。
 */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { TAG_LABELS, BULLETIN_NATURES, PROJECT_TYPES, type Tag } from './config.ts';

interface Args {
  db: string;
  tag: string;
  city: string;
  from: string;
  to: string;
  keyword: string;
  nature: string;
  limit: number;
  format: 'table' | 'json' | 'csv';
  out: string;
  stats: boolean;
  withBody: boolean;
  /**
   * 严口径：只看主类别。
   * 默认（宽口径）按 tags 匹配，会把"产业园EPC（含供配电）"这类多属性项目也带出来，
   * 那个项目确实有电力施工内容，但主体是房建。两种口径都给，由使用者决定。
   */
  strict: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, d: string) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };

  return {
    db: get('db', 'data/index.db'),
    tag: get('tag', ''),
    city: get('city', ''),
    from: get('from', ''),
    to: get('to', ''),
    keyword: get('keyword', ''),
    nature: get('nature', ''),
    limit: Number(get('limit', '50')),
    format: get('format', 'table') as Args['format'],
    out: get('out', ''),
    stats: argv.includes('--stats'),
    withBody: argv.includes('--with-body'),
    strict: argv.includes('--strict'),
  };
}

const args = parseArgs(process.argv.slice(2));
const db = new DatabaseSync(args.db);

// ---- 统计模式 ----
if (args.stats) {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM announcement').get() as { n: number }).n;

  console.log(`库内公告 ${total} 条\n`);

  console.log('按业务类别（primary_tag 去重）：');
  const byTag = db
    .prepare('SELECT primary_tag AS t, COUNT(*) AS n FROM announcement GROUP BY primary_tag ORDER BY n DESC')
    .all() as Array<{ t: string | null; n: number }>;
  for (const r of byTag) {
    console.log(`  ${(r.t ? TAG_LABELS[r.t as Tag] : '(未归类)').padEnd(8)} ${r.n}`);
  }

  console.log('\n按公告性质：');
  const byNature = db
    .prepare('SELECT bulletin_nature AS t, COUNT(*) AS n FROM announcement GROUP BY t ORDER BY n DESC')
    .all() as Array<{ t: string; n: number }>;
  for (const r of byNature) {
    console.log(`  ${(BULLETIN_NATURES[r.t] ?? r.t).padEnd(10)} ${r.n}`);
  }

  console.log('\n按城市：');
  const byCity = db
    .prepare('SELECT city, COUNT(*) AS n FROM announcement GROUP BY city ORDER BY n DESC')
    .all() as Array<{ city: string; n: number }>;
  console.log('  ' + byCity.map((r) => `${r.city}${r.n}`).join('  '));

  console.log('\n按站点行业分类：');
  const byType = db
    .prepare('SELECT project_type AS t, COUNT(*) AS n FROM announcement GROUP BY t ORDER BY n DESC')
    .all() as Array<{ t: string; n: number }>;
  for (const r of byType) {
    // 站点字段存的是编码（1..5），要显示成中文名；空值单独标注
    console.log(`  ${(PROJECT_TYPES[r.t] ?? (r.t || '(空)')).padEnd(6)} ${r.n}`);
  }

  db.close();
  process.exit(0);
}

// ---- 检索 ----
const where: string[] = [];
const params: Array<string | number> = [];

if (args.tag) {
  if (args.strict) {
    where.push('primary_tag = ?');
    params.push(args.tag);
  } else {
    // tags 是 JSON 数组，包含匹配才能覆盖多标签
    where.push("(primary_tag = ? OR tags LIKE ?)");
    params.push(args.tag, `%"${args.tag}"%`);
  }
}
if (args.city) {
  where.push('city LIKE ?');
  params.push(`%${args.city}%`);
}
if (args.nature) {
  where.push('bulletin_nature = ?');
  params.push(args.nature);
}
if (args.from) {
  where.push('pub_date >= ?');
  params.push(args.from);
}
if (args.to) {
  where.push('pub_date <= ?');
  params.push(args.to);
}
if (args.keyword) {
  where.push('(title LIKE ? OR body_text LIKE ?)');
  params.push(`%${args.keyword}%`, `%${args.keyword}%`);
}

const bodyCol = args.withBody ? ', body_text AS body' : '';
const sql = `
  SELECT guid, city, district, title, pub_date AS pubDate,
         bulletin_nature AS nature, project_type AS projectType,
         primary_tag AS primaryTag, tags, evidence, origin_url AS originUrl${bodyCol}
  FROM announcement
  ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
  ORDER BY pub_date DESC
  LIMIT ?
`;

const rows = db.prepare(sql).all(...params, args.limit) as Array<Record<string, unknown>>;

if (rows.length === 0) {
  console.log('没有匹配的公告。');
  db.close();
  process.exit(0);
}

// ---- 输出 ----
if (args.format === 'json') {
  const text = JSON.stringify(rows, null, 2);
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, text, 'utf8');
    console.log(`已写入 ${args.out}（${rows.length} 条）`);
  } else {
    console.log(text);
  }
} else if (args.format === 'csv') {
  // 列数必须与下面的数据行一一对应——之前 header 9 列、数据 10 列，
  // Excel 打开后从第 10 列起整行错位。
  const header = ['日期', '城市', '区县', '类别', '公告类型', '站点分类', '标题', '原文链接', 'guid', '全部标签'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(',')];
  for (const r of rows) {
    const tags = JSON.parse(String(r.tags ?? '[]')) as Tag[];
    lines.push(
      [
        r.pubDate,
        r.city,
        r.district,
        r.primaryTag ? TAG_LABELS[r.primaryTag as Tag] : '',
        BULLETIN_NATURES[String(r.nature)] ?? '',
        PROJECT_TYPES[String(r.projectType)] ?? '',
        r.title,
        r.originUrl,
        r.guid,
        // 多标签也带上，避免丢失信息
        tags.map((t) => TAG_LABELS[t]).join('|'),
      ]
        .map(esc)
        .join(','),
    );
  }
  const text = '\ufeff' + lines.join('\r\n'); // BOM 让 Excel 正确识别 UTF-8
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, text, 'utf8');
    console.log(`已写入 ${args.out}（${rows.length} 条）`);
  } else {
    console.log(text);
  }
} else {
  console.log(`共 ${rows.length} 条（最多显示 ${args.limit} 条）\n`);
  for (const r of rows) {
    const tags = JSON.parse(String(r.tags ?? '[]')) as Tag[];
    const tagText = tags.length ? tags.map((t) => TAG_LABELS[t]).join('+') : '未归类';
    console.log(`${r.pubDate}  ${String(r.city).padEnd(5)}  [${tagText}]  ${r.title}`);
    console.log(`         ${r.originUrl ?? '(无原文链接)'}`);
    if (args.withBody) {
      console.log(`         ${String(r.body ?? '').slice(0, 200)}…`);
    }
  }
}

db.close();
