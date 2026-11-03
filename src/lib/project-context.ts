/**
 * 项目本体信号：同类基线、澄清主题、标准核对。
 *
 * 为什么单独成层而不进 Ruleset：
 *   Ruleset 是全局规则（有 hash、被 eval 断言）。这三块是**按项目变化的事实**，
 *   混进去会让 hash 变成"规则+项目"的混合指纹，eval 基线失效。
 *
 * 三条硬规则（每一条都来自实测）：
 * 1. **多值即不出信号**：同一公告下有多个不同工期/限价 → 写进 notes，不取平均。
 * 2. **样本不足不出标签**：n 小于门槛就不给"紧/宽"，只给"无可靠基准（n=12）"。
 * 3. **不清不楚就降级**：章节找不到、类型识别不了、标准库没收录，都如实说，不猜。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { BidDoc } from './bid-text.ts';
import { loadProjectBoq, type BoqSignal } from './boq-signal.ts';
import { classifyQa, type QaTopic } from './qa-topics.ts';
import {
  buildStandardIndex,
  extractCitations,
  judgeCitation,
  normalizeCode,
  type Judgment,
  type StandardRow,
} from './standard-cite.ts';

// ---------------------------------------------------------------- 造价档位

/** 7 档，单位万元。不要复用 scale-profile.ts 的 TIERS——那份把元当万元用。 */
const TIERS: Array<{ name: string; min: number; max: number }> = [
  { name: '<500万', min: 0, max: 500 },
  { name: '500-1000万', min: 500, max: 1000 },
  { name: '1000-3000万', min: 1000, max: 3000 },
  { name: '3000-5000万', min: 3000, max: 5000 },
  { name: '5000万-1亿', min: 5000, max: 10000 },
  { name: '1-3亿', min: 10000, max: 30000 },
  { name: '>3亿', min: 30000, max: Number.POSITIVE_INFINITY },
];

export function tierOf(amountYuan: number): string {
  const wan = amountYuan / 1e4;
  for (const t of TIERS) if (wan >= t.min && wan < t.max) return t.name;
  return '>3亿';
}

// ---------------------------------------------------------------- 统计

export interface Stat {
  n: number;
  p25: number;
  p50: number;
  p75: number;
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export function statOf(values: number[]): Stat | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75) };
}

// ---------------------------------------------------------------- 基线

export interface Baseline {
  /** 造价档位 → 工期分布 */
  durationByTier: Map<string, Stat>;
  durationAll: Stat | null;
  /** 造价档位 → 限价分布 */
  limitByTier: Map<string, Stat>;
}

/** 多值即丢弃：同一公告多个不同数字时不参与统计（与 price-stats 的 singlePrice 同思路） */
function singlePerAnnouncement(rows: Array<{ g: string; v: number }>): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const arr = groups.get(r.g);
    if (arr) arr.push(r.v);
    else groups.set(r.g, [r.v]);
  }
  const out = new Map<string, number>();
  for (const [g, arr] of groups) {
    const uniq = new Set(arr.map((x) => Math.round(x)));
    if (uniq.size === 1) out.set(g, arr[0]);
  }
  return out;
}

export function loadBaseline(db: DatabaseSync): Baseline {
  // 工期：30-2000 天，按公告去重
  const durRows = db
    .prepare('SELECT announcement_guid g, days v FROM tender_duration WHERE days BETWEEN 30 AND 2000')
    .all() as Array<{ g: string; v: number }>;
  const dur = singlePerAnnouncement(durRows);

  // 限价：只用 price_kind='限价'，按公告去重
  const limRows = db
    .prepare(
      "SELECT announcement_guid g, amount v FROM tender_control_price WHERE price_kind='限价' AND amount > 1000",
    )
    .all() as Array<{ g: string; v: number }>;
  const lim = singlePerAnnouncement(limRows);

  // 档位 → 工期：只有同时有工期和限价的项目才能归入档位
  const byTier = new Map<string, number[]>();
  const all: number[] = [];
  for (const [g, amount] of lim) {
    const days = dur.get(g);
    if (days === undefined) continue;
    const t = tierOf(amount);
    const arr = byTier.get(t) ?? [];
    arr.push(days);
    byTier.set(t, arr);
    all.push(days);
  }

  // 档位 → 限价分布
  const limByTier = new Map<string, number[]>();
  for (const [, amount] of lim) {
    const t = tierOf(amount);
    const arr = limByTier.get(t) ?? [];
    arr.push(amount);
    limByTier.set(t, arr);
  }

  const toStats = (m: Map<string, number[]>): Map<string, Stat> => {
    const out = new Map<string, Stat>();
    for (const [k, arr] of m) {
      const s = statOf(arr);
      if (s) out.set(k, s);
    }
    return out;
  };

  return {
    durationByTier: toStats(byTier),
    durationAll: statOf(all),
    limitByTier: toStats(limByTier),
  };
}

// ---------------------------------------------------------------- 澄清主题

export interface QaItem {
  topicId: string;
  name: string;
  count: number;
  /** 本项目条数 / 本项目澄清总条数 */
  share: number;
  /** 其中与评分标准相关的条数 */
  scoring: number;
  /** 原文示例（最多 2 条，各 ≤120 字） */
  examples: string[];
}

export interface QaSignal {
  /** 本项目去重后澄清条数；0 表示没有澄清数据 */
  n: number;
  items: QaItem[];
  /** 未归类的问题（项目专属），最多 5 条 */
  unclassified: string[];
  /** project = 来自本项目；global = 只有全库先验 */
  confidence: 'project' | 'global';
}

export interface ClarificationRow {
  question: string | null;
  answer: string | null;
}

/**
 * 单项目澄清信号。
 * n < 3 时 confidence='global'：条数太少不足以代表本项目，只能说"全库常见"。
 */
export function loadProjectQa(rows: ClarificationRow[], topics: QaTopic[]): QaSignal {
  if (rows.length === 0) {
    return { n: 0, items: [], unclassified: [], confidence: 'global' };
  }

  const acc = new Map<string, { count: number; scoring: number; examples: string[] }>();
  const unclassified: string[] = [];

  for (const r of rows) {
    const c = classifyQa(r.question ?? '', r.answer ?? '', topics);
    if (c.topics.length === 0) {
      if (unclassified.length < 5 && (r.question ?? '').length > 10) {
        unclassified.push((r.question ?? '').trim().slice(0, 120));
      }
      continue;
    }
    for (const id of c.topics) {
      const a = acc.get(id) ?? { count: 0, scoring: 0, examples: [] };
      a.count += 1;
      if (c.scoring) a.scoring += 1;
      if (a.examples.length < 2) a.examples.push((r.question ?? '').trim().slice(0, 120));
      acc.set(id, a);
    }
  }

  const items: QaItem[] = [...acc.entries()]
    .map(([topicId, a]) => ({
      topicId,
      name: topics.find((t) => t.id === topicId)?.name ?? topicId,
      count: a.count,
      share: a.count / rows.length,
      scoring: a.scoring,
      examples: a.examples,
    }))
    // 先按条数，再按 id —— 保证同输入同顺序
    .sort((a, b) => b.count - a.count || a.topicId.localeCompare(b.topicId));

  return {
    n: rows.length,
    items,
    unclassified,
    confidence: rows.length >= 3 ? 'project' : 'global',
  };
}

// ---------------------------------------------------------------- 标准核对

export interface StandardFinding {
  raw: string;
  verdict: Judgment['verdict'];
  libCode?: string;
  newer?: string;
  note?: string;
  line: number;
}

export interface StandardSignal {
  /** 是否找到「编制依据」章节 */
  located: boolean;
  cited: number;
  findings: StandardFinding[];
  /** 本项目类型应引但未引的核心标准（仅 P2 的 8 条） */
  missingCore: string[];
  /** 应引未引的全文强制规范 */
  missingMandatory: string[];
  /** 类型未识别时不判漏引 */
  typeKnown: boolean;
  confidence: 'high' | 'low';
}

const BASIS_TOPIC = 'SG-BASIS';

export function checkProjectStandards(
  db: DatabaseSync,
  bid: BidDoc,
  projectType: string | null,
): StandardSignal {
  const sections = bid.sections.filter((s) => s.topicId === BASIS_TOPIC);
  const located = sections.length > 0;

  // 找不到章节时全文兜底检索，但 confidence 降为 low，且不判漏引
  const lines = bid.lines;
  const cites = located
    ? sections.flatMap((s) => extractCitations(lines, s.startLine, s.endLine))
    : extractCitations(lines);

  const idx = buildStandardIndex(db);
  const findings: StandardFinding[] = cites.map((c) => {
    const j = judgeCitation(c, idx);
    return { raw: c.raw, verdict: j.verdict, libCode: j.libCode, newer: j.newer, note: j.note, line: c.line };
  });

  const typeKnown = Boolean(projectType);
  const missingCore: string[] = [];
  const missingMandatory: string[] = [];

  if (located && typeKnown) {
    const citedBases = new Set(
      cites.map((c) => c.base).concat(cites.map((c) => c.looseBase)),
    );
    // 应引清单：按 base 去重、只留现行最高年份（standard_project 里有 25 组新旧版本并存）
    const rows = db
      .prepare(
        `SELECT s.code, s.mandatory_level AS ml, m.priority
         FROM standard_project m JOIN standard_ref s ON s.code = m.std_code
         WHERE m.project_type = ? AND s.status = '现行'`,
      )
      .all(projectType) as Array<{ code: string; ml: string; priority: number }>;

    const byBase = new Map<string, { code: string; ml: string; priority: number }>();
    for (const r of rows) {
      const key = r.code.replace(/-\d{4}$/, '');
      const prev = byBase.get(key);
      if (!prev || r.code > prev.code) byBase.set(key, r);
    }

    for (const [base, r] of byBase) {
      if (citedBases.has(base)) continue;
      // 文件号（住建部令第37号 / 建办质〔2018〕31号）不是标准号，
      // 标书不会以标准号形式引用它们，判漏引会 100% 误报
      if (!normalizeCode(r.code)) continue;
      if (r.ml === '全文强制') missingMandatory.push(r.code);
      else if (r.priority === 2) missingCore.push(r.code);
    }
  }

  return {
    located,
    cited: cites.length,
    findings,
    missingCore: missingCore.sort(),
    missingMandatory: missingMandatory.sort(),
    typeKnown,
    confidence: located && typeKnown ? 'high' : 'low',
  };
}

// ---------------------------------------------------------------- 态势

export interface ScheduleSignal {
  days: number | null;
  /** 命中的基线（档位或全局） */
  baseline: Stat | null;
  baselineName: string;
  /** 本项目工期在基线里的位置：tighter/longer/normal/unknown */
  level: '偏紧' | '偏宽' | '正常' | '无可靠基准';
  note?: string;
}

/** 工期态势：只给分位，不给"短 25%"这种没有分母的说法 */
export function scheduleOf(
  db: DatabaseSync,
  announcementGuid: string,
  amountYuan: number | null,
  baseline: Baseline,
): ScheduleSignal {
  const rows = db
    .prepare(
      'SELECT days FROM tender_duration WHERE announcement_guid = ? AND days BETWEEN 30 AND 2000',
    )
    .all(announcementGuid) as Array<{ days: number }>;

  if (rows.length === 0) {
    return { days: null, baseline: null, baselineName: '', level: '无可靠基准', note: '本项目未抽取到工期' };
  }
  const uniq = new Set(rows.map((r) => r.days));
  if (uniq.size > 1) {
    return {
      days: null,
      baseline: null,
      baselineName: '',
      level: '无可靠基准',
      note: `工期存在多个取值（${[...uniq].join('/')} 天），不取平均`,
    };
  }
  const days = rows[0].days;

  // 回退链：档位 → 全局
  let baselineName = '全局';
  let b = baseline.durationAll;
  if (amountYuan !== null) {
    const t = tierOf(amountYuan);
    const tb = baseline.durationByTier.get(t);
    if (tb && tb.n >= 30) {
      b = tb;
      baselineName = t;
    }
  }
  if (!b) {
    return { days, baseline: null, baselineName: '', level: '无可靠基准', note: '基线样本不足' };
  }
  if (b.n < 30) {
    return {
      days,
      baseline: b,
      baselineName,
      level: '无可靠基准',
      note: `同类样本不足（n=${b.n}），不出结论`,
    };
  }

  if (days <= b.p25) return { days, baseline: b, baselineName, level: '偏紧' };
  if (days >= b.p75) return { days, baseline: b, baselineName, level: '偏宽' };
  return { days, baseline: b, baselineName, level: '正常' };
}

// ---------------------------------------------------------------- 总装

export interface LimitSignal {
  /** 本项目最高投标限价（元）；多值冲突时为 null */
  amount: number | null;
  tier: string | null;
  /** 同档位限价分布 */
  baseline: Stat | null;
}

export interface ProjectContext {
  announcementGuid: string;
  projectType: string | null;
  qa: QaSignal;
  schedule: ScheduleSignal;
  limit: LimitSignal;
  standards: StandardSignal;
  /** 清单推导的施工方案；null = 没有 zip 附件，schemes 空 = 有附件但无可用清单 */
  boq: BoqSignal | null;
  /** 所有降级原因，按发生顺序 */
  notes: string[];
}

export interface BuildOptions {
  announcementGuid: string;
  /** 用户显式指定的项目类型；null 表示未指定（则不判强制规范漏引） */
  projectType?: string | null;
  topics: QaTopic[];
  clarifications: ClarificationRow[];
}

export function buildProjectContext(db: DatabaseSync, bid: BidDoc, opts: BuildOptions): ProjectContext {
  const notes: string[] = [];

  // ---- 限价 ----
  const limRows = db
    .prepare(
      "SELECT amount FROM tender_control_price WHERE announcement_guid = ? AND price_kind = '限价' AND amount > 1000",
    )
    .all(opts.announcementGuid) as Array<{ amount: number }>;
  const uniq = new Set(limRows.map((r) => Math.round(r.amount)));
  let amount: number | null = null;
  if (uniq.size === 1) amount = limRows[0].amount;
  else if (uniq.size > 1) notes.push(`限价存在多个取值（${[...uniq].length} 个），不出档位结论`);

  const baseline = loadBaseline(db);
  const tier = amount !== null ? tierOf(amount) : null;
  const limit: LimitSignal = {
    amount,
    tier,
    baseline: tier ? (baseline.limitByTier.get(tier) ?? null) : null,
  };

  // ---- 工期态势 ----
  const schedule = scheduleOf(db, opts.announcementGuid, amount, baseline);
  if (schedule.note) notes.push(schedule.note);

  // ---- 澄清 ----
  const qa = loadProjectQa(opts.clarifications, opts.topics);
  if (qa.n === 0) notes.push('本项目没有澄清数据，只能给全库先验');
  else if (qa.confidence === 'global') notes.push(`本项目澄清仅 ${qa.n} 条，不足以代表本项目`);

  // ---- 标准 ----
  const standards = checkProjectStandards(db, bid, opts.projectType ?? null);
  if (!standards.located) notes.push('未找到「编制依据」章节，已全文检索，不判漏引');
  if (!standards.typeKnown) notes.push('未指定项目类型，不判强制规范漏引');

  // ---- 清单 ----
  // 只有 4.5% 的招标附件里带 Excel 清单，拿不到是常态，不是失败
  let boq: BoqSignal | null = null;
  try {
    boq = loadProjectBoq(db, opts.announcementGuid);
  } catch (e) {
    notes.push(`清单解析失败：${String(e).slice(0, 60)}`);
  }
  if (boq === null) notes.push('本项目没有 zip 附件，无法从清单推导施工方案');
  else if (boq.schemes.length === 0) notes.push(boq.note ?? '附件里没有可解析的工程量清单');

  return {
    announcementGuid: opts.announcementGuid,
    projectType: opts.projectType ?? null,
    qa,
    schedule,
    limit,
    standards,
    boq,
    notes,
  };
}
