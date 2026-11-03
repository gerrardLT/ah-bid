/**
 * 清单 → 施工方案 扫描。
 *
 * 输入：src/boq-index.py 给出的「含 Excel 的 zip」索引
 * 处理：每个 zip 调 boq-extract.py --zip，解析其中的全部 Excel
 * 输出：每个项目「按清单编码推导，必须写哪些施工方案」
 *
 * 为什么用清单编码而不是项目名称：12 位国标编码的前 4 位就是专业+章
 * （0304=电气设备安装、0105=混凝土），比 NLP 分类准，且不需要训练。
 *
 * 用法：
 *   node --no-warnings src/boq-scan.ts --out=output/清单扫描.md
 *   node --no-warnings src/boq-scan.ts --limit=5          # 只看前 5 个 zip
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseCsv } from './lib/selfcheck/compile-rules.ts';

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const OUT = argOf('out');
const LIMIT = Number(argOf('limit') ?? 0);

interface Scheme {
  prefix: string;
  name: string;
  profession: string;
  scheme: string;
}
interface BoqRow {
  code: string;
  name: string;
  feature: string;
  unit: string;
  qty: number;
}

function loadMap(): Map<string, Scheme> {
  const rows = parseCsv(readFileSync('rules/boq/scheme-map.csv', 'utf8').replace(/^\uFEFF/, ''));
  const h = rows[0].map((x) => x.trim());
  const i = {
    prefix: h.indexOf('prefix'),
    name: h.indexOf('name'),
    profession: h.indexOf('profession'),
    scheme: h.indexOf('scheme'),
  };
  for (const [k, v] of Object.entries(i)) {
    if (v < 0) throw new Error(`scheme-map.csv 缺少列「${k}」`);
  }
  const m = new Map<string, Scheme>();
  for (const r of rows.slice(1)) {
    const p = (r[i.prefix] ?? '').trim();
    if (!p) continue;
    m.set(p, {
      prefix: p,
      name: (r[i.name] ?? '').trim(),
      profession: (r[i.profession] ?? '').trim(),
      scheme: (r[i.scheme] ?? '').trim(),
    });
  }
  return m;
}

const py = (args: string[]): string =>
  execFileSync('python', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

const map = loadMap();
const index = JSON.parse(py(['src/boq-index.py'])) as Array<{
  path: string;
  file: string;
  excel: string[];
}>;
const targets = index.slice(0, LIMIT || undefined);

const schemeStat = new Map<
  string,
  { profession: string; count: number; projects: Set<string>; top: Map<string, { qty: number; unit: string }> }
>();

let okZip = 0;
let failZip = 0;
let totalRows = 0;
let mappedRows = 0;
const perProject: Array<{ file: string; rows: number; schemes: Array<{ s: string; n: number }>; unmapped: number }> = [];

for (const z of targets) {
  let parsed: { ok: boolean; files?: Array<{ ok: boolean; rows?: BoqRow[]; error?: string }> };
  try {
    parsed = JSON.parse(py(['src/boq-extract.py', `--zip=${join('data', z.path)}`]));
  } catch {
    failZip++;
    continue;
  }
  if (!parsed.ok || !parsed.files) {
    failZip++;
    continue;
  }

  const rows: BoqRow[] = [];
  for (const f of parsed.files) if (f.ok && f.rows) rows.push(...f.rows);
  if (rows.length === 0) {
    failZip++;
    continue;
  }
  okZip++;
  totalRows += rows.length;

  const groups = new Map<string, number>();
  let unmapped = 0;
  for (const r of rows) {
    const s = map.get(r.code.slice(0, 4));
    if (!s) {
      unmapped++;
      continue;
    }
    mappedRows++;
    groups.set(s.scheme, (groups.get(s.scheme) ?? 0) + 1);

    const g =
      schemeStat.get(s.scheme) ??
      { profession: s.profession, count: 0, projects: new Set<string>(), top: new Map<string, { qty: number; unit: string }>() };
    g.count++;
    g.projects.add(z.path);
    const key = r.name.slice(0, 10);
    const cur = g.top.get(key) ?? { qty: 0, unit: r.unit };
    cur.qty += r.qty;
    g.top.set(key, cur);
    schemeStat.set(s.scheme, g);
  }

  perProject.push({
    file: z.file,
    rows: rows.length,
    schemes: [...groups.entries()].map(([s, n]) => ({ s, n })).sort((a, b) => b.n - a.n),
    unmapped,
  });
}

// ---------------- 输出 ----------------
const out: string[] = [];
out.push('# 工程量清单 → 施工方案 扫描');
out.push('');
out.push(`> 库内 zip ${index.length} 个，含 Excel 的 ${index.length} 个；本次扫描 ${targets.length} 个`);
out.push(`> 解析成功 ${okZip} 个，失败 ${failZip} 个`);
out.push(
  `> 清单行 ${totalRows}，映射到施工方案 ${mappedRows}（${totalRows ? ((mappedRows / totalRows) * 100).toFixed(1) : 0}%）`,
);
out.push('');
out.push('## 一、方案分布（按覆盖项目数）');
out.push('');
out.push('> ⚠ 主要材料是**原始累加，未去重、未校核单位**（同一编码可能在多个标段/单体重复计入）。');
out.push('> 它只用来判断「这个项目有没有这类活」，**不能直接引用到技术标里**。');
out.push('');
out.push('| 专业 | 施工方案 | 清单项数 | 覆盖项目 | 主要材料（未校核，仅供识别） |');
out.push('|---|---|---|---|---|');
const ordered = [...schemeStat.entries()].sort((a, b) => b[1].projects.size - a[1].projects.size || b[1].count - a[1].count);
for (const [name, g] of ordered) {
  const top = [...g.top.entries()]
    .filter(([, v]) => v.qty > 0)
    .sort((a, b) => b[1].qty - a[1].qty)
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v.qty.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}${v.unit}`)
    .join('、');
  out.push(`| ${g.profession} | ${name} | ${g.count} | ${g.projects.size} | ${top || '—'} |`);
}
out.push('');
out.push('## 二、逐项目明细（前 10）');
out.push('');
for (const p of perProject.slice(0, 10)) {
  out.push(`### ${p.file}`);
  out.push('');
  out.push(`清单 ${p.rows} 项，映射 ${p.rows - p.unmapped} 项${p.unmapped ? `（${p.unmapped} 项编码未在映射表内）` : ''}`);
  out.push('');
  out.push(
    `需写方案：${p.schemes.map((x) => `${x.s}(${x.n})`).join('、') || '—'}`,
  );
  out.push('');
}

const text = out.join('\n');
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  console.log(`已生成：${OUT}`);
} else {
  console.log(text);
}
console.error(
  `[统计] zip ${targets.length}｜成功 ${okZip} 失败 ${failZip}｜清单行 ${totalRows}｜映射率 ${totalRows ? ((mappedRows / totalRows) * 100).toFixed(1) : 0}%｜方案 ${schemeStat.size} 类`,
);
