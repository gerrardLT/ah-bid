/**
 * 清单信号：查某个项目的招标附件里有没有工程量清单，有就推导"必须写哪些施工方案"。
 *
 * 三个设计决定：
 * 1. **只认编码前缀，不看项目名称**：12 位国标编码前 4 位就是专业+章
 *    （0304 电气设备安装、0105 混凝土），比 NLP 分类准且不用训练。
 * 2. **工程量不外传**：原始累加未去重、未校核单位（配线能累出 498 万米），
 *    只用来判断"有没有这类活"，报告里不展示数字。
 * 3. **没有清单就返回 null**：514 个 zip 里只有 23 个含 Excel（4.5%），
 *    大多数项目注定拿不到，不能假装有。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import type { BidDoc } from './bid-text.ts';
import { parseCsv } from './selfcheck/compile-rules.ts';

export interface Scheme {
  prefix: string;
  name: string;
  profession: string;
  scheme: string;
}

export interface BoqRow {
  code: string;
  name: string;
  feature: string;
  unit: string;
  qty: number;
}

export interface SchemeHit {
  scheme: string;
  profession: string;
  /** 该方案下的清单项数 */
  count: number;
  /** 主要分项名称（按工程量排序，但不展示数量） */
  top: string[];
}

export interface BoqSignal {
  /** 该项目有几个 zip 附件 */
  zips: number;
  /** 其中成功解析出清单的 zip 数 */
  parsedZips: number;
  /** 清单行数 */
  rows: number;
  /** 编码不在映射表内的项数 */
  unmapped: number;
  schemes: SchemeHit[];
  /** 每个方案在标书里的覆盖情况；只有 buildProjectContext 会填（它拿得到 BidDoc） */
  coverage?: CoverageHit[];
  note?: string;
}

let cachedMap: Map<string, Scheme> | null = null;

export function loadSchemeMap(): Map<string, Scheme> {
  if (cachedMap) return cachedMap;
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
  const map = new Map<string, Scheme>();
  for (const r of rows.slice(1)) {
    const p = (r[i.prefix] ?? '').trim();
    if (!p) continue;
    map.set(p, {
      prefix: p,
      name: (r[i.name] ?? '').trim(),
      profession: (r[i.profession] ?? '').trim(),
      scheme: (r[i.scheme] ?? '').trim(),
    });
  }
  cachedMap = map;
  return map;
}

/** 按方案分组；工程量只用于排序，不返回 */
export function groupBoq(
  rows: BoqRow[],
  map = loadSchemeMap(),
): { schemes: SchemeHit[]; unmapped: number } {
  const acc = new Map<string, { profession: string; count: number; items: Map<string, number> }>();
  let unmapped = 0;

  for (const r of rows) {
    const s = map.get(r.code.slice(0, 4));
    if (!s) {
      unmapped++;
      continue;
    }
    const g = acc.get(s.scheme) ?? { profession: s.profession, count: 0, items: new Map<string, number>() };
    g.count++;
    const key = r.name.slice(0, 12);
    g.items.set(key, (g.items.get(key) ?? 0) + r.qty);
    acc.set(s.scheme, g);
  }

  const schemes: SchemeHit[] = [...acc.entries()]
    .map(([scheme, g]) => ({
      scheme,
      profession: g.profession,
      count: g.count,
      top: [...g.items.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k]) => k),
    }))
    .sort((a, b) => b.count - a.count || a.scheme.localeCompare(b.scheme));

  return { schemes, unmapped };
}

/**
 * 查一个项目的清单信号。
 * 返回 null 表示该项目没有 zip 附件；schemes 为空表示有 zip 但没有可用清单。
 */
export function loadProjectBoq(db: DatabaseSync, announcementGuid: string): BoqSignal | null {
  const zips = db
    .prepare(
      `SELECT local_path p FROM attachment
       WHERE announcement_guid = ? AND ext = '.zip' AND status = 'ok' AND local_path IS NOT NULL`,
    )
    .all(announcementGuid) as Array<{ p: string }>;

  if (zips.length === 0) return null;

  let parsedZips = 0;
  const rows: BoqRow[] = [];
  for (const z of zips) {
    try {
      const out = execFileSync('python', ['src/boq-extract.py', `--zip=${join('data', z.p)}`], {
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        timeout: 60_000,
      });
      const j = JSON.parse(out) as { ok: boolean; files?: Array<{ ok: boolean; rows?: BoqRow[] }> };
      if (!j.ok || !j.files) continue;
      let got = 0;
      for (const f of j.files) {
        if (f.ok && f.rows?.length) {
          rows.push(...f.rows);
          got += f.rows.length;
        }
      }
      if (got > 0) parsedZips++;
    } catch {
      // 单个 zip 失败不影响其他
    }
  }

  if (rows.length === 0) {
    return {
      zips: zips.length,
      parsedZips: 0,
      rows: 0,
      unmapped: 0,
      schemes: [],
      note: `${zips.length} 个附件 zip 里没有可解析的工程量清单`,
    };
  }

  const { schemes, unmapped } = groupBoq(rows);
  return { zips: zips.length, parsedZips, rows: rows.length, unmapped, schemes };
}

// ---------------------------------------------------------------- 覆盖检查

export interface CoverageHit {
  scheme: string;
  covered: boolean;
  /** 命中的关键词 */
  matched?: string;
  line?: number;
  snippet?: string;
}

let cachedEvidence: Map<string, string[]> | null = null;

/** 方案 → 标书里该出现的关键词 */
export function loadSchemeEvidence(): Map<string, string[]> {
  if (cachedEvidence) return cachedEvidence;
  const rows = parseCsv(readFileSync('rules/boq/scheme-evidence.csv', 'utf8').replace(/^\uFEFF/, ''));
  const h = rows[0].map((x) => x.trim());
  const si = h.indexOf('scheme');
  const ki = h.indexOf('keywords');
  if (si < 0 || ki < 0) throw new Error('scheme-evidence.csv 缺少 scheme/keywords 列');
  const m = new Map<string, string[]>();
  for (const r of rows.slice(1)) {
    const s = (r[si] ?? '').trim();
    if (!s) continue;
    m.set(
      s,
      (r[ki] ?? '')
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean),
    );
  }
  cachedEvidence = m;
  return m;
}

/**
 * 清单推导出的方案，在标书里有没有对应内容。
 *
 * 判定与 diagnose 的 term 证据同一口径：命中行去掉关键词后必须还剩 ≥8 字，
 * 否则「1.1 电气安装」这种小标题会让所有方案都"已覆盖"。
 */
export function checkSchemeCoverage(bid: BidDoc, schemes: SchemeHit[]): CoverageHit[] {
  const ev = loadSchemeEvidence();
  const out: CoverageHit[] = [];

  for (const s of schemes) {
    const kws = ev.get(s.scheme) ?? [];
    let hit: CoverageHit | null = null;
    for (let i = 0; i < bid.lines.length && !hit; i++) {
      const line = bid.lines[i];
      for (const kw of kws) {
        const idx = line.indexOf(kw);
        if (idx < 0) continue;
        const rest = (line.slice(0, idx) + line.slice(idx + kw.length))
          .replace(/^[\s:：、.．\d#\-|]+/, '')
          .trim();
        if (rest.length < 8) continue;
        hit = {
          scheme: s.scheme,
          covered: true,
          matched: kw,
          line: i,
          snippet: line.slice(Math.max(0, idx - 16), idx + 44).trim(),
        };
        break;
      }
    }
    out.push(hit ?? { scheme: s.scheme, covered: false });
  }
  return out;
}
