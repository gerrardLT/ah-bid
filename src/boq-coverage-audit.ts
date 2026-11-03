/**
 * 清单覆盖体检：拿一份通用施组模板，去体检所有有清单的项目。
 *
 * 回答的问题不是「某个项目缺什么」，而是「**模板的盲区在哪**」——
 * 37 个项目（私有 17 + 公开 20）同时跑，看哪些施工方案最常被漏。
 *
 * 这件事不需要真实标书：模板本身就是「章节齐全、但没针对任何具体项目」的样本，
 * 正是绝大多数投标人的起点。
 *
 * 用法：
 *   node --no-warnings src/boq-coverage-audit.ts --out=output/清单覆盖体检.md
 *   node --no-warnings src/boq-coverage-audit.ts --template=path/to/bid.docx
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { prepare } from './lib/bid-text.ts';
import { checkSchemeCoverage, groupBoq, loadSchemeMap, type BoqRow } from './lib/boq-signal.ts';

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const TEMPLATE = argOf('template') ?? 'test/fixtures/bid/full.md';
const OUT = argOf('out');

const py = (args: string[]): string =>
  execFileSync('python', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

const doc = prepare(TEMPLATE);
const map = loadSchemeMap();

interface Audit {
  name: string;
  source: '私有清单库' | '公开附件';
  all: string[];
  covered: number;
  missing: string[];
}

const audits: Audit[] = [];

function auditOne(name: string, source: Audit['source'], rows: BoqRow[]): void {
  const { schemes } = groupBoq(rows, map);
  if (schemes.length === 0) return;
  const cov = checkSchemeCoverage(doc, schemes);
  audits.push({
    name,
    source,
    all: schemes.map((s) => s.scheme),
    covered: cov.filter((c) => c.covered).length,
    missing: cov.filter((c) => !c.covered).map((c) => c.scheme),
  });
}

// ---------------- 私有清单 ----------------
const db = new DatabaseSync(join('data', 'index.db'), { readOnly: true });
const projects = db.prepare('SELECT DISTINCT project FROM bid_boq_item').all() as Array<{ project: string }>;
for (const { project } of projects) {
  const rows = db
    .prepare('SELECT code, name, feature, unit, qty FROM bid_boq_item WHERE project = ?')
    .all(project) as BoqRow[];
  auditOne(project, '私有清单库', rows);
}
db.close();

// ---------------- 公开附件 ----------------
const index = JSON.parse(py(['src/boq-index.py'])) as Array<{ path: string; file: string }>;
for (const z of index) {
  let parsed: { ok: boolean; files?: Array<{ ok: boolean; rows?: BoqRow[] }> };
  try {
    parsed = JSON.parse(py(['src/boq-extract.py', `--zip=${join('data', z.path)}`]));
  } catch {
    continue;
  }
  if (!parsed.ok || !parsed.files) continue;
  const rows: BoqRow[] = [];
  for (const f of parsed.files) if (f.ok && f.rows) rows.push(...f.rows);
  auditOne(z.file, '公开附件', rows);
}

// ---------------- 汇总 ----------------
const appear = new Map<string, number>();
const miss = new Map<string, number>();
for (const a of audits) {
  for (const s of a.all) appear.set(s, (appear.get(s) ?? 0) + 1);
  for (const s of a.missing) miss.set(s, (miss.get(s) ?? 0) + 1);
}

const totalSchemes = audits.reduce((s, a) => s + a.all.length, 0);
const totalCovered = audits.reduce((s, a) => s + a.covered, 0);
const nProject = Math.max(1, audits.length);
const avgRate = totalSchemes ? (totalCovered / totalSchemes) * 100 : 0;

const out: string[] = [];
out.push('# 清单覆盖体检：通用施组模板的盲区');
out.push('');
out.push(`> 模板：\`${TEMPLATE}\`（${doc.chars.toLocaleString('zh-CN')} 字 / ${doc.sections.length} 章）`);
out.push(
  `> 体检对象：${audits.length} 个有清单的项目` +
    `（私有 ${audits.filter((a) => a.source === '私有清单库').length} 个 + 公开 ${audits.filter((a) => a.source === '公开附件').length} 个）`,
);
out.push('');
out.push('## 一、总体');
out.push('');
out.push(
  `模板覆盖 **${totalCovered} / ${totalSchemes}** 个「项目-方案」组合，覆盖率 **${avgRate.toFixed(1)}%**。` +
    `平均每个项目要求 **${(totalSchemes / nProject).toFixed(1)}** 类方案，模板能答上 **${(totalCovered / nProject).toFixed(1)}** 类。`,
);
out.push('');
out.push('## 二、最常被漏的方案（按缺失项目数排序）');
out.push('');
out.push('> 缺失率 = 缺失项目数 / 出现该方案的项目数。**100% = 凡是有这类活的项目，模板都没写**。');
out.push('');
out.push(
  '> ⚠ 解读边界：默认模板是按**同一套规则**机械生成的，所以「100% 缺失」' +
    '反映的是**规则库自身的盲区**，不是真实投标人的写作水平。' +
    '换任意一份真实施组跑 `--template=xxx.docx`，得到的才是那份标书的盲区。',
);
out.push('');
out.push('| 施工方案 | 缺失项目数 | 出现项目数 | 缺失率 |');
out.push('|---|---|---|---|');
const ranked = [...miss.entries()]
  .map(([s, m]) => ({ s, m, a: appear.get(s) ?? m }))
  .sort((x, y) => y.m - x.m || y.a - x.a);
for (const r of ranked.slice(0, 20)) {
  out.push(`| ${r.s} | ${r.m} | ${r.a} | ${((r.m / r.a) * 100).toFixed(0)}% |`);
}
out.push('');
out.push('## 三、逐项目');
out.push('');
out.push('| 项目 | 来源 | 方案数 | 覆盖 | 覆盖率 |');
out.push('|---|---|---|---|---|');
for (const a of [...audits].sort((x, y) => x.covered / x.all.length - y.covered / y.all.length)) {
  out.push(
    `| ${a.name.slice(0, 40)} | ${a.source} | ${a.all.length} | ${a.covered} | ${((a.covered / a.all.length) * 100).toFixed(0)}% |`,
  );
}
out.push('');

const text = out.join('\n');
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  console.log(`已生成：${OUT}`);
} else {
  console.log(text);
}
console.error(
  `[统计] 项目 ${audits.length}｜方案/项目均值 ${(totalSchemes / nProject).toFixed(1)}｜覆盖率 ${avgRate.toFixed(1)}%`,
);
