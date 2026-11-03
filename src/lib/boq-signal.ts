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
