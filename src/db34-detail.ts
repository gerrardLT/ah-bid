/**
 * 抓 DB34 标准详情页，提取替代关系与元数据。
 *
 * 详情页字段：标准状态 / 发布日期 / 实施日期 / 制修订 / 代替标准 /
 *            中国标准分类号 / 国际标准分类号 / 技术归口 / 批准发布部门 /
 *            行业分类 / 标准类别 / 备案号 / 备案日期 / 适用范围 / 起草单位
 *
 * 「代替标准」是正向的（新标准声明替代了谁）。反向的「被谁替代」
 * 由本脚本在全部抓完后反推出来。
 *
 * 只抓工程建设类（726 条）：全量 5651 条要 2.4 小时，不值得——
 * 非工程标准的替代关系对写技术标没用。
 *
 * 用法：node --no-warnings src/db34-detail.ts [--limit=N] [--all]
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { request } from './fetch/http.ts';

const DATA = 'data';
const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};

const strip = (s: string): string =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

// 加列（幂等）
const cols = new Set((db.prepare('PRAGMA table_info(db34_standard)').all() as Array<{ name: string }>).map((c) => c.name));
for (const [name, type] of [
  ['replaces', 'TEXT'], // 代替标准（正向）
  ['replaced_by', 'TEXT'], // 被谁替代（反推）
  ['scope', 'TEXT'], // 适用范围
  ['ccs', 'TEXT'], // 中国标准分类号
  ['ics', 'TEXT'], // 国际标准分类号
  ['dept', 'TEXT'], // 技术归口
  ['std_type', 'TEXT'], // 标准类别
  ['revision', 'TEXT'], // 制修订（制定/修订）
  ['detail_at', 'TEXT'],
] as const) {
  if (!cols.has(name)) db.exec(`ALTER TABLE db34_standard ADD COLUMN ${name} ${type}`);
}

const limit = Number(argOf('limit') ?? 0);
const all = process.argv.includes('--all');
const where = all ? '' : 'AND is_construction = 1';
const sql = `SELECT pk, code FROM db34_standard
             WHERE detail_at IS NULL ${where}
             ORDER BY CASE status WHEN '现行' THEN 0 WHEN '有更新版' THEN 1 ELSE 2 END
             ${limit ? `LIMIT ${limit}` : ''}`;
const rows = db.prepare(sql).all() as Array<{ pk: string; code: string }>;

console.log(`待抓详情 ${rows.length} 条${all ? '（全量）' : '（仅工程建设类）'}`);

const up = db.prepare(`
UPDATE db34_standard SET replaces=?, scope=?, ccs=?, ics=?, dept=?, std_type=?, revision=?, detail_at=?
WHERE pk=?`);

/** 取「标签 值」：从标签后到下一个已知标签之前 */
const LABELS = ['代替标准', '中国标准分类号', '国际标准分类号', '技术归口', '批准发布部门', '行业分类', '标准类别', '备案号', '备案日期', '备案公告', '备案月报', '适用范围', '起草单位', '制修订', '发布日期', '实施日期', '标准状态'];
function fieldOf(t: string, label: string): string | null {
  const i = t.indexOf(label);
  if (i < 0) return null;
  const start = i + label.length;
  let end = t.length;
  for (const l of LABELS) {
    if (l === label) continue;
    const j = t.indexOf(l, start);
    if (j > start && j < end) end = j;
  }
  const v = t.slice(start, end).replace(/^[：:\s]+/, '').trim();
  return v || null;
}

const t0 = Date.now();
let ok = 0;
let failed = 0;
let withReplace = 0;

for (const [i, r] of rows.entries()) {
  try {
    const res = await request(`https://dbba.sacinfo.org.cn/stdDetail/${r.pk}`, { timeoutMs: 25000 });
    const t = strip(res.text);
    const replaces = fieldOf(t, '代替标准');
    up.run(
      replaces,
      fieldOf(t, '适用范围'),
      fieldOf(t, '中国标准分类号'),
      fieldOf(t, '国际标准分类号'),
      fieldOf(t, '技术归口'),
      fieldOf(t, '标准类别'),
      fieldOf(t, '制修订'),
      new Date().toISOString(),
      r.pk,
    );
    ok++;
    if (replaces) withReplace++;
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${rows.length}，已抓到代替关系 ${withReplace} 条`);
  } catch (e) {
    failed++;
    if (failed <= 3) console.log(`  ✗ ${r.code}：${String(e).slice(0, 70)}`);
  }
}

// 反推「被谁替代」：A 的 replaces 是 B → B 的 replaced_by 是 A
const all2 = db.prepare('SELECT pk, code, replaces FROM db34_standard WHERE replaces IS NOT NULL').all() as Array<{
  pk: string;
  code: string;
  replaces: string;
}>;
const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
const byCode = new Map(
  (db.prepare('SELECT code, pk FROM db34_standard').all() as Array<{ code: string; pk: string }>).map((x) => [norm(x.code), x.pk]),
);
const setBy = db.prepare('UPDATE db34_standard SET replaced_by = ? WHERE pk = ?');
let linked = 0;
for (const a of all2) {
  const target = norm(a.replaces.split(/[，,、;；]/)[0] ?? '');
  const pk = byCode.get(target);
  if (pk && pk !== a.pk) {
    setBy.run(a.code, pk);
    linked++;
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n完成：成功 ${ok}，失败 ${failed}；带「代替标准」的 ${withReplace} 条，反推建立替代链 ${linked} 条；耗时 ${secs}s`);
const stat = db.prepare('SELECT COUNT(*) n, SUM(detail_at IS NOT NULL) d, SUM(replaces IS NOT NULL) r, SUM(replaced_by IS NOT NULL) b FROM db34_standard WHERE is_construction=1').get() as {
  n: number;
  d: number;
  r: number;
  b: number;
};
console.log(`工程建设类 ${stat.n} 条：已抓详情 ${stat.d}，有替代目标 ${stat.r}，已被替代 ${stat.b}`);
db.close();
