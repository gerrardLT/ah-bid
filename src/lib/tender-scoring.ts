/**
 * 评分项 / 废标项 / 澄清的读取实现 —— 从 tech-bid-scoring.ts 抽出。
 *
 * 为什么抽：自检器要读同样的数据，如果各写一份 SCORE_COND，
 * 迟早出现"两个脚本对同一份文件给出不同评分项"的分裂（这个项目在
 * 下浮率上已经吃过一次教训，见 src/lib/price-stats.ts 的文件头）。
 *
 * 抽出的硬约束：tech-bid-scoring.ts 的行为必须逐字节不变。
 * 所以"引用型条目过滤"（见附表/详见第X章）默认关闭，只有自检器显式打开——
 * 打开会改变评分项清单，不能影响既有产物。
 */

import type { DatabaseSync } from 'node:sqlite';

export const SCORE_COND =
  "cells_json LIKE '%分值%' OR cells_json LIKE '%得分%' OR cells_json LIKE '%评分标准%' OR cells_json LIKE '%评分因素%'";

export const REJECT_COND =
  "cells_json LIKE '%符合性评审%' OR cells_json LIKE '%资格评审%' OR cells_json LIKE '%否决%' OR cells_json LIKE '%废标%' OR cells_json LIKE '%无效投标%' OR cells_json LIKE '%不予受理%' OR cells_json LIKE '%作废标%' OR cells_json LIKE '%投标无效%'";

/**
 * 评分表里混入的"分值构成"说明行——它们提到"100 分"但不是评分项，
 * 不过滤的话会被误认为一个 100 分的评分条目排在首位。
 * 注意：PDF 提取会把词拆开（实测「分值构 成」中间有空格），必须去空格后再匹配。
 */
export const NOT_A_ITEM = ['分值构成', '分值组成', '分值分配', '分值设置', '评标办法前附表'];

export const isNotItem = (text: string): boolean => {
  const t = text.replace(/\s+/g, '');
  return NOT_A_ITEM.some((k) => t.includes(k));
};

export const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 从单元格数组拼出可读的一行；去掉全空单元格 */
export const rowText = (cellsJson: string): string => {
  try {
    const cells = JSON.parse(cellsJson) as unknown[];
    return cells.map((c) => clean(String(c ?? ''))).filter(Boolean).join(' | ');
  } catch {
    return '';
  }
};

/** 从行里抽分值：优先「（N 分）」形式，退而求其次取纯数字单元格 */
export const scoreOf = (text: string): number | null => {
  const m = /[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/.exec(text) ?? /(\d+(?:\.\d+)?)\s*分/.exec(text);
  return m ? Number(m[1]) : null;
};

/** 去重（同一张表跨页重复出现时，文本完全一致） */
export const dedup = <T extends { text: string }>(arr: T[]): T[] => {
  const seen = new Set<string>();
  return arr.filter((x) => (seen.has(x.text) ? false : (seen.add(x.text), true)));
};

/**
 * 「见附表」「详见第X章」这类引用型条目：不是评分点本身，只是指向别处。
 *
 * 注意不要把「按…执行」写进来——实测它会把真实评分标准
 * （「按国家现行验收规范执行…」）一起砍掉，213 行只剩 1 条。
 * 只有明确指向另一处的写法才算引用。
 */
const REFERENCE_RE = /^见附表|详见第|见第.{1,3}[章节]|参见附表/;

export interface ScoreRow {
  page: number;
  text: string;
}

export interface LoadOptions {
  /**
   * 过滤引用型条目。默认 false —— tech-bid-scoring.ts 依赖原有行为，
   * 打开会改变它已产出的三份材料包。自检器传 true。
   */
  dropReferences?: boolean;
}

export function loadScoreItems(
  db: DatabaseSync,
  attachGuid: string,
  opts: LoadOptions = {},
): ScoreRow[] {
  const rows = db
    .prepare(
      `SELECT page, seq, cells_json FROM scoring_item WHERE attach_guid = ? AND (${SCORE_COND}) ORDER BY page, seq`,
    )
    .all(attachGuid) as Array<{ page: number; seq: number; cells_json: string }>;

  return rows
    .map((r) => ({ page: r.page, text: rowText(r.cells_json) }))
    .filter(
      (r) =>
        r.text.length > 6 && !isNotItem(r.text) && !(opts.dropReferences && REFERENCE_RE.test(r.text)),
    );
}

export function loadRejectItems(
  db: DatabaseSync,
  attachGuid: string,
  opts: LoadOptions = {},
): ScoreRow[] {
  const rows = db
    .prepare(
      `SELECT page, seq, cells_json FROM scoring_item WHERE attach_guid = ? AND (${REJECT_COND}) ORDER BY page, seq`,
    )
    .all(attachGuid) as Array<{ page: number; seq: number; cells_json: string }>;

  return rows
    .map((r) => ({ page: r.page, text: rowText(r.cells_json) }))
    .filter((r) => r.text.length > 6 && !(opts.dropReferences && REFERENCE_RE.test(r.text)));
}

export interface Clarification {
  seq: number;
  question: string;
  answer: string;
  affects: string | null;
}

/**
 * 澄清问答：同一问题可能被多份澄清文件重复收录，按 question 前 80 字去重。
 * 「问：」前缀在去重键里剥掉，否则一条原文、一条去掉前缀会被当成两条。
 */
export function loadClarifications(db: DatabaseSync, announcementGuid: string): Clarification[] {
  const raw = db
    .prepare(
      `SELECT seq, question, answer, affects FROM clarification_qa WHERE announcement_guid = ? ORDER BY seq`,
    )
    .all(announcementGuid) as Clarification[];

  const seenQ = new Set<string>();
  return raw.filter((c) => {
    const k = (c.question ?? '').replace(/^\s*问\s*[：:]\s*/, '').slice(0, 80);
    if (seenQ.has(k)) return false;
    seenQ.add(k);
    return true;
  });
}
