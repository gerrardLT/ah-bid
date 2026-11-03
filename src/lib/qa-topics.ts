/**
 * 澄清答疑的主题分类。
 *
 * 目的：把 6,544 条散落的问答，收敛成「这个项目在问什么」。
 * 投标人集体提问的地方，往往就是这个项目不明确、有风险、需要重点写的地方。
 *
 * 三条设计原则（来自实测）：
 * 1. **不靠 affects 字段**：66% 为空，靠它就等于放弃三分之二的数据。
 * 2. **答案只做极性判断，不改写**：实测朴素统计"认可"1,931 条，
 *    按否定优先后否定 391 / 肯定 816 —— 直接把答案当结论会读反。
 * 3. **主题必须可审计**：词表在 rules/qa/question-topics.csv，专家可改。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCsv } from './selfcheck/compile-rules.ts';

export interface QaTopic {
  id: string;
  name: string;
  keywords: string[];
  exclude: string[];
  typical: string;
}

function splitMulti(v: string | undefined): string[] {
  return (v ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadQaTopics(dir = 'rules/qa'): QaTopic[] {
  const path = join(dir, 'question-topics.csv');
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error(`${path} 是空文件`);
  const header = rows[0].map((h) => h.trim());
  const idx = {
    id: header.indexOf('topic_id'),
    name: header.indexOf('name'),
    keywords: header.indexOf('keywords'),
    exclude: header.indexOf('exclude'),
    typical: header.indexOf('typical'),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0) throw new Error(`${path} 缺少列「${k}」，表头：${header.join(', ')}`);
  }

  const out: QaTopic[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const id = (r[idx.id] ?? '').trim();
    if (!id) throw new Error(`${path}:${i + 2} topic_id 为空`);
    if (seen.has(id)) throw new Error(`${path}:${i + 2} topic_id 重复：${id}`);
    seen.add(id);
    const keywords = splitMulti(r[idx.keywords]);
    if (keywords.length === 0) throw new Error(`${path}:${i + 2} keywords 为空：${id}`);
    out.push({
      id,
      name: (r[idx.name] ?? '').trim(),
      keywords,
      exclude: splitMulti(r[idx.exclude]),
      typical: (r[idx.typical] ?? '').trim(),
    });
  });
  return out;
}

export type Polarity = 'neg' | 'pos' | 'defer' | 'unknown';

export interface QaClass {
  /** 命中的主题 id，可能多个 */
  topics: string[];
  /** 是否与评分标准相关 */
  scoring: boolean;
  /** 招标人答复的倾向；答案太短时为 unknown */
  polarity: Polarity;
}

const SCORING_RE = /评分|评审|得分|加分|扣分|权重|分值|评标|定标/;
// 否定优先：先判否定，再判肯定。实测「予以认可」会被「认可」误判为肯定，这里靠顺序保证
const NEG_RE = /不认可|不予认可|不同意|不满足|不接受|不可以|不属于|不予|否决|无效|拒绝/;
const POS_RE = /认可|同意|满足|可以|属于|接受|允许/;
const DEFER_RE = /按招标文件执行|按原招标文件|自行考虑|详见|参照|以招标文件为准|不作调整/;

export function classifyQa(question: string, answer: string, topics: QaTopic[]): QaClass {
  const text = `${question ?? ''} ${answer ?? ''}`.replace(/\s+/g, '');

  const hit = topics.filter(
    (t) =>
      t.keywords.some((k) => text.includes(k)) && !t.exclude.some((e) => text.includes(e)),
  );

  // 答案 <15 字时不足以判极性（多为「是」「详见附件」这类）
  const a = (answer ?? '').replace(/\s+/g, '');
  let polarity: Polarity = 'unknown';
  if (a.length >= 15) {
    if (NEG_RE.test(a)) polarity = 'neg';
    else if (DEFER_RE.test(a)) polarity = 'defer';
    else if (POS_RE.test(a)) polarity = 'pos';
  }

  return { topics: hit.map((t) => t.id), scoring: SCORING_RE.test(text), polarity };
}

/** 按 question 前 80 字去重（与 tender-scoring.loadClarifications 同一口径） */
export function dedupeQuestions<T extends { question: string | null }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = (r.question ?? '').replace(/^\s*问\s*[：:]\s*/, '').slice(0, 80);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
