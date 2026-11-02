/**
 * POC：抓一小批真实数据，跑通"列表 → 正文 → 分类 → 入库"全链路，
 * 并输出可人工复核的报告，用来校准关键词规则。
 *
 * 用法：
 *   node src/poc.ts                       # 抓默认样本并分类
 *   node src/poc.ts --types=1,4 --pages=2
 *   node src/poc.ts --reclassify          # 只重算分类，不重抓（调规则时用）
 */

import { writeFileSync, mkdirSync } from 'node:fs';

import { TAG_LABELS, type Tag } from './config.ts';
import { classify, formatEvidence } from './classify.ts';
import { IndexDb } from './db.ts';
import { fetchListPage, fetchDetail, type ListItem } from './source/provincial.ts';

interface Args {
  db: string;
  pages: number;
  types: string[];
  natures: string[];
  limit: number;
  outDir: string;
  reclassify: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, d: string) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };

  return {
    db: get('db', 'data/index.db'),
    pages: Number(get('pages', '1')),
    // 默认跑建筑工程与其他工程：电力/光伏/储能最常落在这两类
    types: get('types', '1,4').split(',').filter(Boolean),
    natures: get('natures', '1').split(',').filter(Boolean),
    limit: Number(get('limit', '40')),
    outDir: get('out', 'data'),
    reclassify: argv.includes('--reclassify'),
  };
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.outDir, { recursive: true });

const db = new IndexDb(args.db);
const startedAt = Date.now();
const listFailures: string[] = [];
const detailFailures: string[] = [];

if (args.reclassify) {
  const n = db.reclassifyAll(classify);
  console.log(`离线重算分类：${n} 条（未重新抓取）`);
} else {
  // ---- 1. 收集列表 ----
  const collected = new Map<string, ListItem>();

  for (const type of args.types) {
    for (const nature of args.natures) {
      for (let page = 1; page <= args.pages; page++) {
        try {
          const list = await fetchListPage({ tenderProjectType: type, bulletinNature: nature, page });
          for (const it of list) collected.set(it.guid, it);
          console.log(`list type=${type} nature=${nature} page=${page} -> ${list.length}`);
        } catch (err) {
          listFailures.push(`type=${type} nature=${nature} page=${page}: ${String(err)}`);
        }
      }
    }
  }

  const items = [...collected.values()].slice(0, args.limit);
  console.log(`\n待处理 ${items.length} 条（去重后共 ${collected.size} 条）\n`);

  // ---- 2. 抓正文 + 分类 + 入库 ----
  let done = 0;
  for (const item of items) {
    if (!db.has(item.guid)) {
      try {
        const detail = await fetchDetail(item);
        const cls = classify(item.title, detail.text);
        db.upsert({ item, detail, classification: cls });
      } catch (err) {
        detailFailures.push(`${item.guid}: ${String(err)}`);
      }
    }
    done++;
    if (done % 10 === 0) console.log(`进度 ${done}/${items.length}`);
  }
}

// ---- 3. 生成报告 ----
interface Row {
  guid: string;
  city: string;
  title: string;
  pubDate: string;
  nature: string;
  projectType: string;
  primaryTag: Tag | null;
  tags: Tag[];
  evidence: string;
  bodyLen: number;
  bodyHead: string;
  originUrl: string | null;
  detailType: string;
}

const rawRows = db.db
  .prepare(
    `SELECT guid, city, title, pub_date AS pubDate, bulletin_nature AS nature,
            project_type AS projectType, primary_tag AS primaryTag, tags,
            evidence, length(body_text) AS bodyLen, substr(body_text, 1, 120) AS bodyHead,
            origin_url AS originUrl, detail_type AS detailType
     FROM announcement ORDER BY pub_date DESC`,
  )
  .all() as Array<Omit<Row, 'tags'> & { tags: string }>;

const rows: Row[] = rawRows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') as Tag[] }));

const tagCount = new Map<string, number>();
const cityCount = new Map<string, number>();
let multiTag = 0;

for (const r of rows) {
  const key = r.primaryTag ?? '(未归类)';
  tagCount.set(key, (tagCount.get(key) ?? 0) + 1);
  cityCount.set(r.city, (cityCount.get(r.city) ?? 0) + 1);
  if (r.tags.length > 1) multiTag++;
}

const withOrigin = rows.filter((r) => r.originUrl).length;
const emptyBody = rows.filter((r) => r.bodyLen < 200).length;

const lines: string[] = [];
const push = (s = '') => lines.push(s);

push('# 安徽省招投标索引 POC 报告');
push();
push(
  `生成时间：${new Date().toLocaleString('zh-CN')}　耗时：${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
);
push();
push('## 抓取概览');
push();
push(`- 入库公告数：**${rows.length}**`);
push(`- 正文非空（>200 字）：${rows.length - emptyBody}`);
push(
  `- 带原文链接（P2 附件前提）：${withOrigin} / ${rows.length}` +
    `（${rows.length ? ((withOrigin / rows.length) * 100).toFixed(0) : 0}%）`,
);
push(`- 命中多个类别的公告：${multiTag}`);
if (listFailures.length) push(`- 列表请求失败：${listFailures.length} 次`);
if (detailFailures.length) push(`- 详情请求失败：${detailFailures.length} 条`);
push();

push('## 业务分类分布（按 primaryTag 去重，合计 = 总数）');
push();
push('| 类别 | 条数 | 占比 |');
push('|---|---|---|');
for (const [k, v] of [...tagCount.entries()].sort((a, b) => b[1] - a[1])) {
  const label = k === '(未归类)' ? k : TAG_LABELS[k as Tag];
  push(`| ${label} | ${v} | ${rows.length ? ((v / rows.length) * 100).toFixed(0) : 0}% |`);
}
push();

push('## 地区分布');
push();
push([...cityCount.entries()].map(([c, n]) => `${c} ${n}`).join('　'));
push();

for (const tag of ['pv', 'storage', 'power', 'building'] as Tag[]) {
  const hit = rows.filter((r) => r.primaryTag === tag);
  if (hit.length === 0) continue;
  push(`## ${TAG_LABELS[tag]}（${hit.length} 条）样本与命中证据`);
  push();
  for (const r of hit.slice(0, 8)) {
    push(`- **${r.title}**`);
    push(`  - ${r.city} · ${r.pubDate} · 站点分类「${r.projectType}」 · 正文 ${r.bodyLen} 字`);
    push(`  - 证据：${r.evidence || '(无)'}`);
    push(`  - tags：${r.tags.map((t) => TAG_LABELS[t]).join(' / ') || '(无)'}`);
  }
  push();
}

push('## 未归类样本（请人工确认是否漏检）');
push();
const untagged = rows.filter((r) => !r.primaryTag);
if (untagged.length === 0) {
  push('（无）');
} else {
  for (const r of untagged.slice(0, 15)) {
    push(`- ${r.title}`);
    push(`  - ${r.city} · ${r.pubDate} · 「${r.projectType}」 · 正文 ${r.bodyLen} 字`);
    push(`  - 正文开头：${r.bodyHead.replace(/\s+/g, ' ').slice(0, 80)}…`);
  }
}
push();

if (detailFailures.length) {
  push('## 详情抓取失败');
  push();
  for (const f of detailFailures.slice(0, 10)) push(`- ${f}`);
  push();
}

const typeUsage = new Map<string, number>();
for (const r of rows) {
  const k = `${r.nature}->${r.detailType}`;
  typeUsage.set(k, (typeUsage.get(k) ?? 0) + 1);
}
push('## 详情 type 参数探测结果');
push();
for (const [k, v] of typeUsage) push(`- ${k}：${v} 条`);
push();

const mdPath = `${args.outDir}/report.md`;
writeFileSync(mdPath, lines.join('\n'), 'utf8');
writeFileSync(`${args.outDir}/poc-result.json`, JSON.stringify(rows, null, 2), 'utf8');

db.close();

console.log(`\n报告已写入 ${mdPath}`);
