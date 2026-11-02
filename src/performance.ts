/**
 * P3 履约信息抓取。
 *
 * 目标：https://ggzy.ah.gov.cn/performance/list（共 14,334 页 ≈ 14.3 万条）
 * 一条记录 = 某主体在某项目上的合同履约情况（合同额、结算额、工期、三达标等）。
 *
 * 用途定位：这是**企业维度**数据——按统一社会信用代码聚合，
 * 得到「某企业在本省做过哪些项目、多大金额、是否达标」。
 * 它对应的是历史项目（2023-2025），与我们的 2026 年公告库时间窗不重叠，
 * 不能用它补公告的中标价。
 *
 * 断点：以详情页 guid 为主键，已存在的跳过；列表页顺序按递交时间倒序。
 *
 * 用法：
 *   node --no-warnings src/performance.ts --pages=3      # 试批（≈30 条）
 *   node --no-warnings src/performance.ts --pages=50     # 500 条
 *   node --no-warnings src/performance.ts --pages=14334  # 全量（约 60 小时）
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { request } from './fetch/http.ts';

const DATA = 'data';
const BASE = 'https://ggzy.ah.gov.cn';

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const PAGES = Number(argOf('pages') ?? 3);
/** 从第几页开始（断点续跑）：已入库的条目会跳过，但重复扫列表页仍浪费时间 */
const FROM = Number(argOf('from') ?? 1);

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');
db.exec(`
CREATE TABLE IF NOT EXISTS performance_record (
  guid              TEXT PRIMARY KEY,
  subject_code      TEXT,
  subject_name      TEXT,
  subject_type      TEXT,
  subject_role      TEXT,
  project_code      TEXT,
  project_name      TEXT,
  section_code      TEXT,
  section_name      TEXT,
  contract_amount   REAL,
  settlement_amount REAL,
  contract_days     INTEGER,
  actual_days       INTEGER,
  sign_date         TEXT,
  submit_date       TEXT,
  safety_ok         TEXT,
  env_ok            TEXT,
  quality_ok        TEXT,
  publisher         TEXT,
  region            TEXT,
  fetched_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perf_subject ON performance_record(subject_code);
CREATE INDEX IF NOT EXISTS idx_perf_project ON performance_record(project_code);
`);

/** 字段顺序与详情页一致；值是「到下一个字段标签之前」的全部内容，避免名称里的空格被截断 */
const LABELS = [
  '主体代码',
  '主体名称',
  '主体类型',
  '主体角色',
  '交易项目编号',
  '交易项目名称',
  '标段编号',
  '标段名称',
  '合同金额(元)',
  '合同结算金额(元)',
  '合同工期(天)',
  '实际工期(天)',
  '合同签署时间',
  '履约信息递交时间',
  '安全达标情况',
  '环保达标情况',
  '质量达标情况',
  '发布部门',
  '来源区划',
  '处理文件文号',
];

const strip = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 按字段标签切分：每个标签的值 = 从冒号后到下一个标签之前 */
function parseFields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const positions: Array<{ label: string; start: number; valueStart: number }> = [];
  for (const label of LABELS) {
    const m = new RegExp(`${label.replace(/[()]/g, '\\$&')}\\s*[：:]`).exec(text);
    if (m) positions.push({ label, start: m.index, valueStart: m.index + m[0].length });
  }
  positions.sort((a, b) => a.start - b.start);
  for (let i = 0; i < positions.length; i++) {
    const end = i + 1 < positions.length ? positions[i + 1].start : Math.min(text.length, positions[i].valueStart + 120);
    out[positions[i].label] = text.slice(positions[i].valueStart, end).trim();
  }
  return out;
}

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const m = /(-?[0-9][0-9,]*\.?[0-9]*)/.exec(s);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
};
const int = (s: string | undefined): number | null => {
  const v = num(s);
  return v === null ? null : Math.round(v);
};
const clean = (s: string | undefined): string | null => (s ? s.replace(/^无$/, '').trim() || null : null);

const ins = db.prepare(`
  INSERT INTO performance_record (
    guid, subject_code, subject_name, subject_type, subject_role,
    project_code, project_name, section_code, section_name,
    contract_amount, settlement_amount, contract_days, actual_days,
    sign_date, submit_date, safety_ok, env_ok, quality_ok, publisher, region, fetched_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(guid) DO NOTHING`);

const exists = db.prepare('SELECT 1 AS x FROM performance_record WHERE guid = ?');

let seen = 0;
let inserted = 0;
let skipped = 0;
let failed = 0;
const t0 = Date.now();

for (let page = FROM; page <= PAGES; page++) {
  // 分页走 POST 表单（#MySearch + hidden currentPage），GET ?page=N 无效：
  // 页面永远是服务端渲染的第 1 页，各页 guid 完全重复。
  const listUrl = `${BASE}/performance/list`;
  let listText: string;
  try {
    listText = (
      await request(listUrl, {
        method: 'POST',
        body: new URLSearchParams({ currentPage: String(page), bodyName: '' }).toString(),
        timeoutMs: 30000,
      })
    ).text;
  } catch (e) {
    console.log(`列表第 ${page} 页失败：${String(e).slice(0, 90)}`);
    failed++;
    continue;
  }
  const guids = [...listText.matchAll(/\/performance\/detail\?guid=([0-9a-f-]{36})/gi)].map((m) => m[1]);

  for (const g of guids) {
    seen++;
    if (exists.get(g)) {
      skipped++;
      continue;
    }
    try {
      const d = await request(`${BASE}/performance/detail?guid=${g}`, { timeoutMs: 30000 });
      const f = parseFields(strip(d.text));
      if (!f['主体名称'] && !f['交易项目名称']) {
        failed++;
        console.log(`  ✗ 字段解析为空 guid=${g.slice(0, 8)}`);
        continue;
      }
      ins.run(
        g,
        clean(f['主体代码']),
        clean(f['主体名称']),
        clean(f['主体类型']),
        clean(f['主体角色']),
        clean(f['交易项目编号']),
        clean(f['交易项目名称']),
        clean(f['标段编号']),
        clean(f['标段名称']),
        num(f['合同金额(元)']),
        num(f['合同结算金额(元)']),
        int(f['合同工期(天)']),
        int(f['实际工期(天)']),
        clean(f['合同签署时间']),
        clean(f['履约信息递交时间']),
        clean(f['安全达标情况']),
        clean(f['环保达标情况']),
        clean(f['质量达标情况']),
        clean(f['发布部门']),
        clean(f['来源区划']),
        new Date().toISOString(),
      );
      inserted++;
      if (inserted <= 5 || inserted % 50 === 0) {
        console.log(
          `  [${inserted}] ${f['主体名称']?.slice(0, 16) ?? '?'} | ${f['交易项目名称']?.slice(0, 24) ?? '?'} | 合同 ${f['合同金额(元)'] ?? '?'} 结算 ${f['合同结算金额(元)'] ?? '?'}`,
        );
      }
    } catch (e) {
      failed++;
      console.log(`  ✗ 详情失败 guid=${g.slice(0, 8)}：${String(e).slice(0, 80)}`);
    }
  }
  console.log(`列表页 ${page}/${PAGES} 完成：累计入库 ${inserted}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n完成：扫到 ${seen} 条，新入库 ${inserted}，已存在跳过 ${skipped}，失败 ${failed}；耗时 ${secs}s`);
const stat = db
  .prepare(
    `SELECT COUNT(*) n, COUNT(DISTINCT subject_code) subj, COUNT(DISTINCT project_code) proj,
            ROUND(SUM(contract_amount)/100000000.0, 2) total_yi
     FROM performance_record`,
  )
  .get() as { n: number; subj: number; proj: number; total_yi: number };
console.log(`库里累计：${stat.n} 条，涉及主体 ${stat.subj} 家，项目 ${stat.proj} 个，合同总额 ${stat.total_yi} 亿元`);
db.close();
