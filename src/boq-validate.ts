/**
 * 清单规则三表校验：scheme-map / scheme-evidence / scheme-outline。
 *
 * 为什么需要这个：三张表靠字符串「方案名」互相引用，而名字是手写的。
 * 一旦有人改了其中一张（比如把「吊顶工程」写成「吊顶与隔墙」），
 * 不会报错，只会**静默失效**——那个方案永远不会被检查、也不给建议。
 *
 * 实测踩过：2026-11 审查发现 7 个方案无证据、5 个无分段、3 个孤儿模板。
 *
 * 用法：node --no-warnings src/boq-validate.ts
 * 退出码：0 通过；1 有问题
 */

import { readFileSync } from 'node:fs';

import { parseCsv } from './lib/selfcheck/compile-rules.ts';

interface Table {
  header: string[];
  rows: string[][];
  at(row: string[], key: string): string;
  column(key: string): string[];
}

function load(path: string): Table {
  const raw = parseCsv(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  const header = (raw[0] ?? []).map((x) => x.trim());
  const rows = raw.slice(1);
  const at = (row: string[], key: string): string => {
    const i = header.indexOf(key);
    return i < 0 ? '' : (row[i] ?? '').trim();
  };
  return { header, rows, at, column: (key: string) => rows.map((r) => at(r, key)) };
}

const map = load('rules/boq/scheme-map.csv');
const evi = load('rules/boq/scheme-evidence.csv');
const out = load('rules/boq/scheme-outline.csv');

const problems: string[] = [];

// --- 1. 表头 ---
const need = (t: Table, keys: string[], label: string): void => {
  for (const k of keys) if (!t.header.includes(k)) problems.push(`${label} 缺少列「${k}」`);
};
need(map, ['prefix', 'name', 'profession', 'scheme'], 'scheme-map.csv');
need(evi, ['scheme', 'keywords'], 'scheme-evidence.csv');
need(out, ['scheme', 'sections'], 'scheme-outline.csv');

// --- 2. prefix 唯一 ---
const seen = new Map<string, number>();
for (const p of map.column('prefix')) seen.set(p, (seen.get(p) ?? 0) + 1);
for (const [p, n] of seen) if (n > 1) problems.push(`scheme-map.csv 前缀「${p}」重复 ${n} 次`);

// --- 3. 三表集合一致 ---
const S_MAP = new Set(map.column('scheme').filter(Boolean));
const S_EVI = new Set(evi.column('scheme').filter(Boolean));
const S_OUT = new Set(out.column('scheme').filter(Boolean));

for (const s of S_MAP) if (!S_EVI.has(s)) problems.push(`「${s}」在 scheme-map 里但没有证据关键词 —— 永远不会被检查`);
for (const s of S_EVI) if (!S_MAP.has(s)) problems.push(`「${s}」在 scheme-evidence 里但 scheme-map 没有 —— 对不上清单`);
for (const s of S_MAP) if (!S_OUT.has(s)) problems.push(`「${s}」在 scheme-map 里但没有分段模板 —— 缺失时给不出建议`);
for (const s of S_OUT) if (!S_MAP.has(s)) problems.push(`「${s}」在 scheme-outline 里但 scheme-map 没有 —— 模板永远用不到`);

// --- 4. 内容非空 / 长度 ---
for (const row of evi.rows) {
  const name = evi.at(row, 'scheme');
  const kws = evi
    .at(row, 'keywords')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);
  if (kws.length === 0) problems.push(`scheme-evidence「${name}」关键词为空`);
  for (const k of kws) if (k.length < 2) problems.push(`scheme-evidence「${name}」有 1 字关键词「${k}」（会误命中）`);
}
for (const row of out.rows) {
  const name = out.at(row, 'scheme');
  const secs = out
    .at(row, 'sections')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);
  if (secs.length < 3) problems.push(`scheme-outline「${name}」分段少于 3 段（共 ${secs.length}）`);
}

// --- 5. 每行必须有专业 ---
for (const row of map.rows) {
  if (!map.at(row, 'profession')) problems.push(`scheme-map 前缀「${map.at(row, 'prefix')}」缺专业`);
}

// --- 输出 ---
if (problems.length === 0) {
  console.log(`校验通过：${S_MAP.size} 个方案，三表一致（map/evidence/outline）`);
  process.exit(0);
}
console.error(`发现 ${problems.length} 个问题：`);
for (const p of problems) console.error(`  - ${p}`);
process.exit(1);
