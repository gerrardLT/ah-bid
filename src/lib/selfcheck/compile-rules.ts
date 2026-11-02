/**
 * 规则编译：三张 CSV → Ruleset（含编译后的正则与内容指纹）。
 *
 * 为什么在运行期编译而不是读一份预生成的 JSON：
 *   多一份产物就多一个"忘记重新编译"的失败模式。CSV 只有几十 KB，
 *   编译一次 < 10ms，直接读 CSV 更不容易出错。
 *   `rules/build/v1.json` 只是给人看的快照（`--write` 时生成）。
 *
 * 编译期就挡住三类问题：
 *   1. evidence 写成 `kind:pattern` 之外的形式
 *   2. 正则写不出来（语法错）
 *   3. 嵌套量词（`(a+)+`）—— 会在长文本上回溯爆炸
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Check, Evidence, EvidenceKind, Ruleset, Tier, Topic } from './types.ts';

const EVIDENCE_KINDS = new Set(['term', 'number', 'section', 'cite', 'regex']);

/** 允许的项目类型。新增类型时同步这里与 rules/v1/topics.csv。 */
export const ALLOWED_APPLIES_TO = new Set([
  '通用',
  '房建',
  '市政',
  '园林',
  '水利',
  '电力',
  '光伏',
  '智能化',
  '老旧小区',
  '装配式',
  '监理设计',
]);

/**
 * 极简 CSV 解析：支持双引号包裹、`""` 转义、CRLF。
 * 不引入第三方库是这个项目的既有约定（见 package.json 无 dependencies）。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim().length > 0));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 嵌套量词的粗筛：`(a+)+`、`(.*)+`、`(a*)*` 这类 */
const NESTED_QUANT = /\([^()]*[+*]\)[+*]/;

export function compileEvidence(raw: string): Evidence {
  const idx = raw.indexOf(':');
  if (idx <= 0) {
    throw new Error(`证据应写成 kind:pattern，实际是「${raw}」`);
  }
  const kind = raw.slice(0, idx).trim();
  const pattern = raw.slice(idx + 1).trim();
  if (!EVIDENCE_KINDS.has(kind)) {
    throw new Error(`未知证据类型「${kind}」，可用 term / number / section / cite / regex`);
  }
  if (!pattern) throw new Error(`证据 pattern 为空：「${raw}」`);
  if (NESTED_QUANT.test(pattern)) {
    throw new Error(`证据含嵌套量词，可能回溯爆炸：「${pattern}」`);
  }

  let re: RegExp;
  if (kind === 'cite' || kind === 'regex') {
    re = new RegExp(pattern);
  } else if (kind === 'number') {
    // 「建筑面积」后面 30 字内必须有数字——否则"建筑面积"四个字堆砌就能拿分
    re = new RegExp(escapeRe(pattern) + '[^\\d\\n]{0,30}\\d');
  } else {
    re = new RegExp(escapeRe(pattern));
  }

  return { kind: kind as EvidenceKind, pattern, re, label: pattern };
}

function splitMulti(v: string): string[] {
  return (v ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readTable(path: string): { header: string[]; rows: string[][] } {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error(`${path} 是空文件`);
  const header = rows[0].map((h) => h.trim());
  // 列数一致性：字段里出现英文逗号（最常见是正则量词 {4,5}）会把一行拆开，
  // 不在这里挡住，下游只会报“reviewed 为空”这种难懂的错误。
  rows.slice(1).forEach((r, i) => {
    if (r.length !== header.length) {
      throw new Error(
        `${path}:${i + 2} 列数 ${r.length}，表头 ${header.length}` +
          `——字段含英文逗号时请用双引号包裹整个字段`,
      );
    }
  });
  return { header, rows: rows.slice(1) };
}

function need(header: string[], col: string, path: string): number {
  const i = header.indexOf(col);
  if (i < 0) throw new Error(`${path} 缺少列「${col}」，实际表头：${header.join(', ')}`);
  return i;
}

export function compileRules(dir = 'rules/v1'): Ruleset {
  const tPath = join(dir, 'topics.csv');
  const cPath = join(dir, 'checks.csv');
  const rPath = join(dir, 'tiers.csv');

  // ---- topics ----
  const t = readTable(tPath);
  const ti = {
    id: need(t.header, 'topic_id', tPath),
    name: need(t.header, 'name', tPath),
    appliesTo: need(t.header, 'applies_to', tPath),
    headings: need(t.header, 'headings', tPath),
    parent: need(t.header, 'parent', tPath),
  };
  const topics: Topic[] = [];
  const topicIds = new Set<string>();
  t.rows.forEach((r, i) => {
    const row = i + 2; // 1 基行号（含表头）
    const id = (r[ti.id] ?? '').trim();
    if (!id) throw new Error(`${tPath}:${row} topic_id 为空`);
    if (topicIds.has(id)) throw new Error(`${tPath}:${row} topic_id 重复：${id}`);
    topicIds.add(id);
    topics.push({
      id,
      name: (r[ti.name] ?? '').trim(),
      appliesTo: splitMulti(r[ti.appliesTo] ?? ''),
      headings: splitMulti(r[ti.headings] ?? ''),
      parent: (r[ti.parent] ?? '').trim() || null,
      sourceRow: row,
    });
  });

  // ---- checks ----
  const c = readTable(cPath);
  const ci = {
    id: need(c.header, 'check_id', cPath),
    topic: need(c.header, 'topic_id', cPath),
    title: need(c.header, 'title', cPath),
    aliases: need(c.header, 'aliases', cPath),
    evidence: need(c.header, 'evidence', cPath),
    reject: need(c.header, 'reject_if_missing', cPath),
    source: need(c.header, 'source', cPath),
    reviewed: need(c.header, 'reviewed', cPath),
    note: c.header.indexOf('expert_note'),
  };
  const checks: Check[] = [];
  const checkIds = new Set<string>();
  c.rows.forEach((r, i) => {
    const row = i + 2;
    const id = (r[ci.id] ?? '').trim();
    if (!id) throw new Error(`${cPath}:${row} check_id 为空`);
    if (checkIds.has(id)) throw new Error(`${cPath}:${row} check_id 重复：${id}`);
    checkIds.add(id);

    const topicId = (r[ci.topic] ?? '').trim();
    if (!topicIds.has(topicId)) {
      throw new Error(`${cPath}:${row} topic_id 不存在：${topicId}`);
    }

    const rawEv = (r[ci.evidence] ?? '').trim();
    if (!rawEv) throw new Error(`${cPath}:${row} evidence 为空`);
    let evidence: Evidence[];
    try {
      evidence = rawEv
        .split('；')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(compileEvidence);
    } catch (e) {
      throw new Error(`${cPath}:${row} 证据编译失败：${(e as Error).message}`);
    }
    if (evidence.length === 0) throw new Error(`${cPath}:${row} evidence 解析后为空`);

    const source = (r[ci.source] ?? '').trim();
    if (!source) throw new Error(`${cPath}:${row} source 为空（每条规则必须有来源）`);

    const reviewed = (r[ci.reviewed] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewed)) {
      throw new Error(`${cPath}:${row} reviewed 应为 YYYY-MM-DD，实际「${reviewed}」`);
    }

    // applies_to 只在 topics 上声明，但类型值必须是允许的
    for (const a of topics.find((x) => x.id === topicId)?.appliesTo ?? []) {
      if (!ALLOWED_APPLIES_TO.has(a)) {
        throw new Error(`${tPath}:${row} 未知项目类型「${a}」`);
      }
    }

    checks.push({
      id,
      topicId,
      title: (r[ci.title] ?? '').trim(),
      aliases: splitMulti(r[ci.aliases] ?? ''),
      evidence,
      rejectIfMissing: (r[ci.reject] ?? '').trim() === '1',
      source,
      reviewed,
      expertNote: ci.note >= 0 ? (r[ci.note] ?? '').trim() : '',
      sourceRow: row,
    });
  });

  // ---- tiers ----
  const rt = readTable(rPath);
  const ri = {
    check: need(rt.header, 'check_id', rPath),
    level: need(rt.header, 'level', rPath),
    min: need(rt.header, 'min_evidence', rPath),
    label: need(rt.header, 'label', rPath),
  };
  const tiers: Record<string, Tier[]> = {};
  rt.rows.forEach((r, i) => {
    const row = i + 2;
    const checkId = (r[ri.check] ?? '').trim();
    if (!checkIds.has(checkId)) throw new Error(`${rPath}:${row} check_id 不存在：${checkId}`);
    const level = Number((r[ri.level] ?? '').trim());
    const minEvidence = Number((r[ri.min] ?? '').trim());
    const label = (r[ri.label] ?? '').trim();
    if (!Number.isInteger(level) || level <= 0) {
      throw new Error(`${rPath}:${row} level 应为正整数，实际「${r[ri.level]}」`);
    }
    if (!Number.isInteger(minEvidence) || minEvidence <= 0) {
      throw new Error(`${rPath}:${row} min_evidence 应为正整数，实际「${r[ri.min]}」`);
    }
    if (!label) throw new Error(`${rPath}:${row} label 为空`);
    (tiers[checkId] ??= []).push({ checkId, level, minEvidence, label });
  });

  // 每条 check 至少一档；min_evidence 必须随 level 严格递增
  for (const ck of checks) {
    const arr = tiers[ck.id];
    if (!arr || arr.length === 0) {
      throw new Error(`${rPath} 缺少 check「${ck.id}」的档位定义`);
    }
    arr.sort((a, b) => a.level - b.level);
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].minEvidence <= arr[i - 1].minEvidence) {
        throw new Error(
          `${rPath} check「${ck.id}」档位 min_evidence 未严格递增：` +
            `${arr[i - 1].level}→${arr[i - 1].minEvidence}，${arr[i].level}→${arr[i].minEvidence}`,
        );
      }
    }
    const maxEv = ck.evidence.length;
    if (arr[0].minEvidence > maxEv) {
      throw new Error(
        `${rPath} check「${ck.id}」最低档要求 ${arr[0].minEvidence} 项证据，但只定义了 ${maxEv} 项`,
      );
    }
  }

  // ---- 内容指纹（不含时间，便于跨版本比较） ----
  const canonical = JSON.stringify({
    topics: topics.map((x) => [x.id, x.name, x.appliesTo, x.headings, x.parent]),
    checks: checks.map((x) => [
      x.id,
      x.topicId,
      x.title,
      x.aliases,
      x.evidence.map((e) => `${e.kind}:${e.pattern}`),
      x.rejectIfMissing,
      x.source,
      x.reviewed,
    ]),
    tiers: Object.keys(tiers)
      .sort()
      .map((k) => [k, tiers[k].map((x) => [x.level, x.minEvidence, x.label])]),
  });
  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 12);

  return {
    schemaVersion: 1,
    hash,
    compiledAt: new Date().toISOString(),
    topics,
    checks,
    tiers,
  };
}
