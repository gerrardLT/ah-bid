/**
 * 全国标准信息公共服务平台查询器——用官方平台核实标准号与状态。
 *
 * 三个接口（都是 GET，分页参数 pageNumber/pageSize）：
 *   国家标准  /gb/search/gbQueryPage?searchText=&ics=&state=&ISSUE_DATE=&pageNumber=&pageSize=
 *   行业标准  /hb/search/hbPage?searchText=&op=&ISSUE_DATE=&pageNumber=&pageSize=
 *   地方标准  /db/search/dbPage?searchText=&op=&ISSUE_DATE=&pageNumber=&pageSize=
 *
 * 踩坑记录（代价：3 轮探测）：
 *   - 这三个接口用 POST 都返回数据但分页不生效，必须用 GET
 *   - 分页参数不是 limit/offset，也不是 current/size，而是 pageNumber/pageSize
 *   - 页面本身是 JS 渲染，列表靠 bootstrap-table，接口地址藏在 resetTable() 里
 *   - 接口路径是 hbPage/dbPage，不是 hbQueryPage/dbQueryPage（后者 404）
 *
 * 用法：
 *   node --no-warnings src/samr-query.ts "SL 223"
 *   node --no-warnings src/samr-query.ts "CJJ 82"
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { request } from './fetch/http.ts';

const DATA = 'data';
const BASE = 'https://std.samr.gov.cn';

interface Row {
  code: string;
  name: string;
  status: string;
  nature?: string;
  issue?: string;
  act?: string;
  replaces?: string;
}

const get = async (u: string): Promise<any> => {
  const r = await request(u, { timeoutMs: 25000 });
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
};

/** 接口返回的字段值带高亮标签（检索词被 <sacinfo> 包裹），必须清洗后才能入库 */
const clean = (v: unknown): string => (v == null ? '' : String(v).replace(/<[^>]+>/g, '')).trim();

/** 三个库依次查，返回每条命中的来源 */
async function queryAll(kw: string): Promise<Array<{ src: string; rows: Row[]; total: number }>> {
  const out: Array<{ src: string; rows: Row[]; total: number }> = [];
  const qs = `searchText=${encodeURIComponent(kw)}&pageSize=50`;

  // 服务端是分词 OR 匹配（搜「CJJ 33」会返回 CB/T 33、HS/T 33），
  // 所以必须多翻几页再在客户端按标准号前缀筛。
  const PAGES = 4;

  // 从查询词里抽标准号前缀，用于客户端过滤（例：SL 223 → SL223）
  // 注意：服务端返回的标准号空格写法不统一（『CJJ 33-2005』/『CJJ33-2005』都可能），
  // 比较前必须先去掉全部空格，否则会漏命中。
  const m = /^([A-Z]{2,3})\s*\/?\s*(T)?\s*(\d{2,6})/i.exec(kw.trim());
  const wantPrefix = m ? `${m[1].toUpperCase()}${m[2] ? '/T' : ''}${m[3]}` : '';
  const matchCode = (code: string): boolean => {
    if (!wantPrefix) return true; // 按名称搜时不过滤
    return code.replace(/\s+/g, '').toUpperCase().startsWith(wantPrefix);
  };

  for (let p = 1; p <= PAGES; p++) {
    const gb = await get(`${BASE}/gb/search/gbQueryPage?${qs}&pageNumber=${p}&ics=&state=&ISSUE_DATE=`);
    if (!gb?.rows?.length) break;
    const rows = gb.rows
      .map((r: any) => ({
        code: clean(r.C_STD_CODE),
        name: clean(r.C_C_NAME),
        status: clean(r.STATE),
        nature: clean(r.STD_NATURE),
        issue: clean(r.ISSUE_DATE),
        act: clean(r.ACT_DATE),
      }))
      .filter((r: Row) => matchCode(r.code));
    if (!out[0]) out[0] = { src: '国家标准', total: gb.total, rows: [] };
    out[0].rows.push(...rows);
    if (out[0].rows.length >= 20) break;
  }

  for (const [src, path] of [
    ['行业标准', '/hb/search/hbPage'],
    ['地方标准', '/db/search/dbPage'],
  ] as const) {
    const grp = { src, total: 0, rows: [] as Row[] };
    for (let p = 1; p <= PAGES; p++) {
      const j = await get(`${BASE}${path}?${qs}&pageNumber=${p}&op=&ISSUE_DATE=`);
      if (!j?.rows?.length) break;
      grp.total = j.total;
      const rows = j.rows
        .map((r: any) => ({
          code: clean(r.C_STD_CODE ?? r.STD_CODE ?? r.code),
          name: clean(r.C_C_NAME ?? r.CH_NAME ?? r.chName),
          status: clean(r.STATE ?? r.status),
          nature: clean(r.STD_NATURE),
          issue: clean(r.ISSUE_DATE ?? r.issueDate),
          act: clean(r.ACT_DATE ?? r.actDate),
        }))
        .filter((r: Row) => matchCode(r.code));
      grp.rows.push(...rows);
      if (grp.rows.length >= 20) break;
    }
    out.push(grp);
  }
  return out;
}

const kw = process.argv[2];
if (!kw) {
  console.log('用法：node src/samr-query.ts "标准号或名称片段"');
  process.exit(1);
}

console.log(`查询「${kw}」……\n`);
const results = await queryAll(kw);

const db = new DatabaseSync(join(DATA, 'index.db'));
const upd = db.prepare(
  "UPDATE standard_ref SET status=?, note=COALESCE(note,'') || ? , verified=1, updated_at=? WHERE code LIKE ?",
);
const now = new Date().toISOString();

let found = 0;
for (const grp of results) {
  console.log(`--- ${grp.src}（共 ${grp.total} 条）---`);
  for (const r of grp.rows.slice(0, 8)) {
    console.log(`  ${String(r.code).padEnd(22)} ${String(r.name).slice(0, 38).padEnd(40)} ${r.status ?? ''} ${r.act ? '实施 ' + r.act : ''}`);
    found++;
  }
  if (grp.rows.length > 8) console.log(`  …还有 ${grp.rows.length - 8} 条`);
}
if (!found) console.log('  未命中');

// 回写库里同前缀的条目（仅当标准号前缀一致时才更新状态）
console.log('\n=== 回写 standard_ref ===');
for (const grp of results) {
  for (const r of grp.rows) {
    if (!r.code) continue;
    const codeNorm = String(r.code).replace(/（.*?）/g, '').trim();
    const n = upd.run(r.status ?? '', `【官方核实 ${now.slice(0, 10)}：${grp.src} ${r.status ?? ''}】`, now, `${codeNorm}%`);
    if (n.changes) console.log(`  ${codeNorm} → ${r.status}（影响 ${n.changes} 条）`);
  }
}
db.close();
