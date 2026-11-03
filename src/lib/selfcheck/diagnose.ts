/**
 * 诊断核心：把「规则」与「标书章节」对齐，产出三态结论 + 推定档位 + 证据行号。
 *
 * 三态定义（这是本模块唯一重要的语义）：
 *   covered   —— 至少命中一项证据，且带原文行号可核对
 *   mentioned —— 章节标题在，但一项证据都没命中（"写了标题没写内容"）
 *   missing   —— 连章节都没有
 *
 * 为什么必须有 mentioned：满篇形容词、零数字零项目名的"AI 空话标"，
 * 章节结构是齐的。如果只判 covered/missing，它会全部通过——这是最危险的情形。
 *
 * 本文件禁止出现：项目类型字面量（房建/市政…）、evaluationMethod 分支。
 * 由 src/selfcheck-validate.ts 的源码扫描强制。
 */

import type { BidDoc } from '../bid-text.ts';
import type {
  Check,
  Diagnosis,
  DiagState,
  Evidence,
  EvidenceHit,
  Ruleset,
  Tier,
  Topic,
} from './types.ts';

export interface DiagnoseOptions {
  /** 单条规则的匹配预算（毫秒）；超时记入 timeouts 并在报告里点名，不静默降级 */
  ruleBudgetMs?: number;
}

export interface DiagnoseResult {
  diagnoses: Diagnosis[];
  /** 有检查项的 topic 中，在标书里找到章节的比例（0-1） */
  sectionCoverage: number;
  /** 超时的规则 id */
  timeouts: string[];
  /** 标书里完全没出现的 topic */
  missingTopics: string[];
}

/** topic 在文中可能有多段（同一标题出现两次），合并所有命中的段 */
interface TopicSpan {
  topicId: string;
  sections: string[];
  /** 各段全文（含标题行），用于计算正文字数 */
  texts: string[];
  fromLine: number;
  toLine: number;
  /** 是否找到章节 */
  found: boolean;
  /** 去标题行、去空白后的正文字数 */
  bodyChars: number;
}

function buildTopicSpans(
  doc: BidDoc,
  topicIds: string[],
  allTopics: Topic[],
): Map<string, TopicSpan> {
  const spans = new Map<string, TopicSpan>();
  for (const id of topicIds) {
    spans.set(id, {
      topicId: id,
      sections: [],
      texts: [],
      fromLine: 0,
      toLine: doc.lines.length - 1,
      found: false,
      bodyChars: 0,
    });
  }
  for (const s of doc.sections) {
    if (!s.topicId) continue;
    const sp = spans.get(s.topicId);
    if (!sp) continue;
    sp.found = true;
    sp.sections.push(s.title);
    sp.texts.push(s.text);
    sp.fromLine = Math.min(sp.fromLine, s.startLine);
    sp.toLine = Math.max(sp.toLine, s.endLine);
  }
  for (const sp of spans.values()) {
    if (!sp.found) {
      // 找不到章节的 topic 退回全文（宁可多查，不可漏判），但保留 found=false 供报告说明
      sp.fromLine = 0;
      sp.toLine = doc.lines.length - 1;
    } else {
      // 正文 = 去掉每段第一行（标题）后，按行去重再计字数。
      // 为什么要去重：空话标把同一段 5 句话重复 13 次就有 313 字，
      // 只看总字数会让「灌水」通过章节级检查（eval 实测抓到 1 条误判）。
      const lines = sp.texts.flatMap((t) => t.split('\n').slice(1));
      const seen = new Set<string>();
      let n = 0;
      for (const line of lines) {
        const t = line.replace(/\s+/g, '');
        if (t.length < 4) continue; // 空行、纯标点、序号行
        if (seen.has(t)) continue; // 重复行只算一次
        seen.add(t);
        n += t.length;
      }
      sp.bodyChars = n;
    }
  }

  // 父章节的体量 = 自身 + 所有直接子章节。
  // 为什么需要：评分表在父级打分（「施工组织设计 20 分」），而标书往往只写子章节（编制依据/工程概况…），
  // 父标题不一定存在。不累加的话，父级规则会因为“自己那段是空的”而误判为无内容。
  const childrenOf = new Map<string, string[]>();
  for (const t of allTopics) {
    if (!t.parent) continue;
    const arr = childrenOf.get(t.parent) ?? [];
    arr.push(t.id);
    childrenOf.set(t.parent, arr);
  }
  for (const [pid, kids] of childrenOf) {
    const sp = spans.get(pid);
    if (!sp) continue;
    for (const k of kids) {
      const ch = spans.get(k);
      if (ch) sp.bodyChars += ch.bodyChars;
    }
  }

  return spans;
}

/**
 * 找一条证据。
 *
 * term 类型额外排除“纯标签行”：技术标常有「1.1 质量管理体系：」这种只有小节标题的行，
 * 词出现了但没有任何实质内容。如果算作证据，任何带小节标题的标书都会全绿——
 * 这是自检器最容易骗人的地方（实测空话标因此被误判 42 条 covered）。
 *
 * section 类型不排除：提到「平面布置图」本身就说明图存在；
 * number 已在编译期要求词后跟数字，无需再判。
 */
function matchOne(
  doc: BidDoc,
  check: Check,
  ev: Evidence,
  span: TopicSpan | undefined,
): EvidenceHit | null {
  // 章节级检查：不看词，看这一章有没有实质内容。
  // 章节不存在或只有标题行时 bodyChars≈0，自然不命中 → 上层判 missing / mentioned。
  if (ev.kind === 'volume') {
    const chars = span?.bodyChars ?? 0;
    if (chars >= (ev.minChars ?? 0)) {
      return {
        checkId: check.id,
        kind: 'volume',
        pattern: ev.pattern,
        line: span?.fromLine ?? 0,
        snippet: `本章节正文去重后 ${chars} 字（门槛 ${ev.minChars}）`,
      };
    }
    return null;
  }

  const from = span?.fromLine ?? 0;
  const to = span?.toLine ?? doc.lines.length - 1;
  const end = Math.min(to, doc.lines.length - 1);
  for (let i = Math.max(0, from); i <= end; i++) {
    const line = doc.lines[i];
    ev.re.lastIndex = 0;
    const m = ev.re.exec(line);
    if (!m) continue;

    if (ev.kind === 'term') {
      const rest = line
        .replace(ev.re, '')
        .replace(/^[\s:：、.．\d#\-|]+/, '')
        .trim();
      if (rest.length < 8) continue; // 标题行/标签行：词出现了，但没有实质内容
    }

    const idx = Math.max(0, (m.index ?? 0) - 20);
    return {
      checkId: check.id,
      kind: ev.kind,
      pattern: ev.pattern,
      line: i,
      snippet: line.slice(idx, idx + 60).trim(),
    };
  }
  return null;
}

function pickTier(hits: number, tiers: Tier[] | undefined): { level: number; label: string } | null {
  if (!tiers || tiers.length === 0 || hits === 0) return null;
  let best: Tier | null = null;
  for (const t of tiers) {
    if (hits >= t.minEvidence && (!best || t.level > best.level)) best = t;
  }
  return best ? { level: best.level, label: best.label } : null;
}

export function diagnose(
  doc: BidDoc,
  ruleset: Ruleset,
  opts: DiagnoseOptions = {},
): DiagnoseResult {
  const budget = opts.ruleBudgetMs ?? 50;

  const topicIds = [...new Set(ruleset.checks.map((c) => c.topicId))];
  const spans = buildTopicSpans(doc, topicIds, ruleset.topics);
  const foundTopics = [...spans.values()].filter((s) => s.found).length;

  const diagnoses: Diagnosis[] = [];
  const timeouts: string[] = [];

  // 版本次序稳定：按 topic 在 rules 中出现的顺序，再按 check id
  const topicOrder = ruleset.topics.map((t) => t.id);
  const ordered = [...ruleset.checks].sort((a, b) => {
    const ta = topicOrder.indexOf(a.topicId);
    const tb = topicOrder.indexOf(b.topicId);
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  for (const check of ordered) {
    const t0 = Date.now();
    const span = spans.get(check.topicId);

    const hits: EvidenceHit[] = [];
    const missing: string[] = [];
    for (const ev of check.evidence) {
      const hit = matchOne(doc, check, ev, span);
      if (hit) hits.push(hit);
      else missing.push(`${ev.kind}:${ev.pattern}`);
      if (Date.now() - t0 > budget) {
        timeouts.push(check.id);
        break;
      }
    }

    let state: DiagState;
    if (hits.length > 0) state = 'covered';
    else if (span?.found) state = 'mentioned';
    else state = 'missing';

    diagnoses.push({
      checkId: check.id,
      topicId: check.topicId,
      title: check.title,
      state,
      hits,
      missing,
      tier: pickTier(hits.length, ruleset.tiers[check.id]),
      rejectRisk: check.rejectIfMissing && hits.length === 0,
      section: span?.found ? (span.sections[0] ?? null) : null,
      bodyChars: check.evidence.some((e) => e.kind === 'volume')
        ? (span?.bodyChars ?? 0)
        : undefined,
    });
  }

  return {
    diagnoses,
    sectionCoverage: topicIds.length ? foundTopics / topicIds.length : 0,
    timeouts,
    missingTopics: [...spans.values()].filter((s) => !s.found).map((s) => s.topicId),
  };
}

/** 便捷统计，报告与 eval 共用 */
export function tally(ds: Diagnosis[]): {
  covered: number;
  mentioned: number;
  missing: number;
  rejectRisk: number;
} {
  return {
    covered: ds.filter((d) => d.state === 'covered').length,
    mentioned: ds.filter((d) => d.state === 'mentioned').length,
    missing: ds.filter((d) => d.state === 'missing').length,
    rejectRisk: ds.filter((d) => d.rejectRisk).length,
  };
}
