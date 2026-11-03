/**
 * 标准号抽取、归一化与查表。
 *
 * 用途：核对技术标「编制依据」章节引用的标准，是否现行、有没有更新版。
 *
 * 三条铁律（都来自实测）：
 * 1. **永不凭推测判"废止"**。`standard_ref` 505 条里 0 条废止记录，
 *    只有 `db34_standard` 有（3,255 条），且其中 207 条有更新版却没 replaced_by。
 *    所以"已废止"只在 db34 明确 `status='废止'` 且 `replaced_by` 非空时输出。
 * 2. **GB 与 GB/T 是两个标准**（强制 vs 推荐），不能合并 base；
 *    DB34/ 与 DB34/T 在库里混用同一序号（如 1466），所以只对 DB 系列做宽松匹配。
 * 3. **"未收录"不等于"错误"**。库只有 505 条 + 5,651 条地标，标书引用面远大于库，
 *    措辞固定为"库内未收录，不作判定"。
 */

import type { DatabaseSync } from 'node:sqlite';

export interface StandardRow {
  code: string;
  base: string;
  year: string | null;
  status: string;
  mandatoryLevel: string;
  source: 'standard_ref' | 'db34';
  replacedBy: string | null;
}

export interface Citation {
  /** 标书里的原文串 */
  raw: string;
  base: string;
  /** 去掉 /T、/J 的宽松基号；仅 DB 系列与 base 不同 */
  looseBase: string;
  year: string | null;
  /** 0 基行号 */
  line: number;
}

export type Verdict = '现行' | '有更新版' | '已废止' | '库内未收录';

export interface Judgment {
  verdict: Verdict;
  /** 命中的库内 code */
  libCode?: string;
  /** 库内现行/替代版本 */
  newer?: string;
  /** 降级说明（未标年份、族类型不一致等） */
  note?: string;
}

/** 族根 + 可选后缀（T/J/Z）+ 序号 + 可选年份。族根只认实测出现过的。 */
const CODE_RE =
  /(?<![A-Z0-9])(GBJ?|JGJ|CJJ|SL|JTG|DL|NB|DB\d{2,5})\s*\/?\s*(T|J|Z)?\s*(\d{1,6}(?:\.\d{1,3})*)\s*(?:[-–—]{1,2}\s*(\d{4}))?/g;

/** 归一化一条标准号；不是标准号返回 null */
export function normalizeCode(raw: string): { base: string; looseBase: string; year: string | null } | null {
  const s = raw
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, '')
    // 「（2016年版）」不是版本年份，去掉避免误当 year
    .replace(/[（(]\d{4}年版[）)]/g, '');

  const re = new RegExp(CODE_RE.source);
  const m = re.exec(s);
  if (!m) return null;
  const [, fam, suffix, num, year] = m;
  const base = suffix ? `${fam}/${suffix} ${num}` : `${fam} ${num}`;
  // 只有 DB 系列存在「同一序号、强制/推荐两种写法」，其余族不合并
  const looseBase = fam.startsWith('DB') ? `${fam} ${num}` : base;
  return { base, looseBase, year: year ?? null };
}

/**
 * 从行范围内抽标准号。
 * 处理 PDF 断行：若某行以族根结尾（如 "GB" / "DB34/T"），拼接下一行再试一次。
 */
export function extractCitations(lines: string[], fromLine = 0, toLine = Number.MAX_SAFE_INTEGER): Citation[] {
  const end = Math.min(toLine, lines.length - 1);
  const seen = new Set<string>();
  const out: Citation[] = [];

  const push = (text: string, line: number): void => {
    const re = new RegExp(CODE_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = normalizeCode(m[0]);
      if (!n) continue;
      const key = `${n.base}|${n.year ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ raw: m[0].trim(), base: n.base, looseBase: n.looseBase, year: n.year, line });
    }
  };

  const TAIL_FAMILY = /(GBJ?|JGJ|CJJ|SL|JTG|DL|NB|DB\d{2,5})\s*\/?\s*(T|J|Z)?\s*$/;

  for (let i = Math.max(0, fromLine); i <= end; i++) {
    const line = lines[i];
    push(line, i);
    // 断行：本行末尾只有族根，标准号主体在下一行
    if (TAIL_FAMILY.test(line.trim()) && i + 1 <= end) {
      push(`${line} ${lines[i + 1]}`, i);
    }
  }
  return out;
}

/** 一次加载两张标准表，建 base → 候选行 的索引 */
export function buildStandardIndex(db: DatabaseSync): {
  byBase: Map<string, StandardRow[]>;
  byLoose: Map<string, StandardRow[]>;
} {
  const byBase = new Map<string, StandardRow[]>();
  const byLoose = new Map<string, StandardRow[]>();

  const add = (row: StandardRow): void => {
    for (const [map, key] of [
      [byBase, row.base],
      [byLoose, row.base.replace(/^([A-Z]+\d*)\/[TJZ] /, '$1 ')],
    ] as const) {
      const arr = map.get(key) ?? [];
      arr.push(row);
      map.set(key, arr);
    }
  };

  // standard_ref：只有「现行 / 有更新版」两种状态
  for (const r of db
    .prepare(
      `SELECT code, status, COALESCE(mandatory_level,'') AS ml
       FROM standard_ref`,
    )
    .all() as Array<{ code: string; status: string; ml: string }>) {
    const n = normalizeCode(r.code);
    if (!n) continue;
    add({
      code: r.code,
      base: n.base,
      year: n.year,
      status: r.status,
      mandatoryLevel: r.ml,
      source: 'standard_ref',
      replacedBy: null,
    });
  }

  // db34_standard：工程建设类才有判定意义；含废止记录
  for (const r of db
    .prepare(
      `SELECT code, status, replaced_by AS rb
       FROM db34_standard WHERE is_construction = 1`,
    )
    .all() as Array<{ code: string; status: string; rb: string | null }>) {
    const n = normalizeCode(r.code);
    if (!n) continue;
    add({
      code: r.code,
      base: n.base,
      year: n.year,
      status: r.status,
      mandatoryLevel: '',
      source: 'db34',
      replacedBy: r.rb,
    });
  }

  // 每个 base 内按年份降序，便于取"最新版"
  for (const map of [byBase, byLoose]) {
    for (const arr of map.values()) {
      arr.sort((a, b) => Number(b.year ?? 0) - Number(a.year ?? 0));
    }
  }
  return { byBase, byLoose };
}

function latestOf(rows: StandardRow[]): StandardRow | null {
  const current = rows.filter((r) => r.status === '现行');
  if (current.length) return current[0];
  return rows[0] ?? null;
}

/**
 * 判定一条引用。
 * 顺序：精确（base+year）→ 同 base 最新 → 宽松（仅 DB）→ 未收录。
 */
export function judgeCitation(
  c: Citation,
  idx: { byBase: Map<string, StandardRow[]>; byLoose: Map<string, StandardRow[]> },
): Judgment {
  const candidates =
    idx.byBase.get(c.base) ?? (c.looseBase !== c.base ? idx.byLoose.get(c.looseBase) : undefined);

  if (!candidates || candidates.length === 0) {
    return { verdict: '库内未收录' };
  }

  // 族类型不一致（如标书写 DB34/T、库里只有 DB34/）要提示核对
  const familyMismatch = candidates.every((r) => r.base !== c.base);
  const mismatchNote = familyMismatch ? `库内为 ${candidates[0].base}，族类型不一致，请核对` : undefined;

  if (c.year) {
    const exact = candidates.find((r) => r.year === c.year);
    if (exact) {
      if (exact.status === '废止' && exact.replacedBy) {
        return {
          verdict: '已废止',
          libCode: exact.code,
          newer: exact.replacedBy,
          note: mismatchNote,
        };
      }
      return { verdict: '现行', libCode: exact.code, note: mismatchNote };
    }
    // 引了库内不存在的年份：按同 base 最新版判"有更新版"
    const latest = latestOf(candidates);
    if (latest && latest.year && Number(c.year) < Number(latest.year)) {
      return {
        verdict: '有更新版',
        newer: latest.code,
        note: [mismatchNote, `引用 ${c.year} 版，库内最新 ${latest.code}`].filter(Boolean).join('；'),
      };
    }
    return {
      verdict: '库内未收录',
      note: `库内有 ${candidates.map((r) => r.year ?? '?').join('/')} 版本，未见 ${c.year} 版`,
    };
  }

  // 未标年份：按同 base 最新版判，并显式提示
  const latest = latestOf(candidates);
  if (!latest) return { verdict: '库内未收录' };
  const multiple = new Set(candidates.map((r) => r.year)).size > 1;
  return {
    verdict: latest.status === '现行' ? '现行' : '有更新版',
    libCode: latest.code,
    newer: latest.status === '现行' ? undefined : latest.code,
    note: [
      multiple ? `未标年份，库内有 ${candidates.length} 个版本，按最新 ${latest.code} 判定` : '未标年份，按库内版本判定',
      mismatchNote,
    ]
      .filter(Boolean)
      .join('；'),
  };
}
