/**
 * 报告渲染：Diagnosis → Markdown / JSON。
 *
 * 展示原则（与 docs/项目深度解析.md 的口径一致）：
 * 1. 不确定的东西必须显式标注 —— 档位写「证据数推定」，不写「预计得分」
 * 2. 不知道的东西必须置顶 —— 未匹配的评分项放在最前，不折叠
 * 3. 每条"已覆盖"都要能核对 —— 带行号与原文摘录，否则不给 covered
 *
 * 评分项与检查项之间只做「标题/别名子串包含」这一种匹配，不做相似度。
 * 匹配率低是事实（骨架规则只有 80 条），不能靠模糊匹配把数字做好看。
 */

import type { BidDoc } from '../bid-text.ts';
import type { Clarification, ScoreRow } from '../tender-scoring.ts';
import { tally, type DiagnoseResult } from './diagnose.ts';
import type { Check, Diagnosis, Ruleset } from './types.ts';

export interface TenderMeta {
  title: string;
  city: string | null;
  pages: number | null;
  scoreTechnical: number;
  evaluationMethod: string | null;
  verified: boolean;
}

export interface ReportInput {
  bid: BidDoc;
  ruleset: Ruleset;
  result: DiagnoseResult;
  scoreItems: ScoreRow[];
  rejects: ScoreRow[];
  clarifications: Clarification[];
  tender: TenderMeta | null;
  /** scoring_item_full 是否有该文件的数据（决定能否展示完整评分原文） */
  hasFullText: boolean;
}

const STATE_CN: Record<Diagnosis['state'], string> = {
  covered: '已覆盖',
  mentioned: '有标题无证据',
  missing: '缺失',
};

/** 评分项 → 检查项：只认「标题或别名被评分项原文包含」，最长匹配优先 */
export function matchOneCheck(text: string, checks: Check[]): Check | null {
  let best: Check | null = null;
  let bestLen = 0;
  for (const c of checks) {
    for (const key of [c.title, ...c.aliases]) {
      if (key.length >= 2 && key.length > bestLen && text.includes(key)) {
        best = c;
        bestLen = key.length;
      }
    }
  }
  return best;
}

export function matchScoreItems(input: ReportInput): Array<{ item: ScoreRow; check: Check | null }> {
  return input.scoreItems.map((item) => ({
    item,
    check: matchOneCheck(item.text, input.ruleset.checks),
  }));
}

function esc(s: string): string {
  return s.replace(/\|/g, '／').replace(/\n/g, ' ');
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 缺项排序：废标风险 → 缺失 → 有标题无证据 → 已覆盖；同级按 checkId */
function rankOf(d: Diagnosis): number {
  if (d.rejectRisk) return 0;
  if (d.state === 'missing') return 1;
  if (d.state === 'mentioned') return 2;
  return 3;
}

export function renderMarkdown(input: ReportInput): string {
  const { bid, ruleset, result, tender } = input;
  const t = tally(result.diagnoses);
  const matched = matchScoreItems(input);
  const unmatched = matched.filter((m) => !m.check);
  const out: string[] = [];

  out.push('# 技术标自检报告');
  out.push('');
  out.push(
    `> 标书：${esc(bid.path.split(/[\\/]/).pop() ?? bid.path)}｜${bid.chars.toLocaleString('zh-CN')} 字｜` +
      `识别章节 ${bid.sections.filter((s) => s.topicId).length} 段` +
      (bid.unsegmented ? '（**未识别出任何标题，结论可靠性下降**）' : ''),
  );
  out.push(
    `> 依据：本项目评分项 ${input.scoreItems.length} 条（其中 ${input.scoreItems.length - unmatched.length} 条能对到规则）` +
      `、通用检查项 ${ruleset.checks.length} 条｜规则版本 \`${ruleset.hash}\``,
  );
  out.push(
    `> 档位为「**证据条数推定**」，不是评委打分；每一条“已覆盖”都附原文行号，可逐条核对。`,
  );
  out.push('');

  // 评分项过少 = 评分表没被完整识别，下面的“未匹配清单”会失真，必须置顶提醒
  if (input.tender && input.scoreItems.length < 8) {
    out.push(
      `> ⚠ **本项目只抽取到 ${input.scoreItems.length} 条评分项**（常规 15\u201340 条），` +
        `评分表可能未被完整识别。下方“未匹配评分项”清单不可信，**请直接查阅招标文件评标办法章节**。`,
    );
    out.push('');
  }

  if (unmatched.length) {
    out.push(`## 一、未匹配的评分项（${unmatched.length} 条，需人工对照）`);
    out.push('');
    out.push('> 这些是本项目评分表里的具体要求，但规则库里还没有对应检查项。');
    out.push('> 它们的缺失不会被下面的诊断发现 —— **这是本报告最大的盲区**。');
    out.push('');
    out.push('| 页码 | 评分项原文 |');
    out.push('|---|---|');
    for (const m of unmatched.slice(0, 40)) {
      out.push(`| p${m.item.page} | ${esc(clip(m.item.text, 160))} |`);
    }
    if (unmatched.length > 40) out.push(`| … | 还有 ${unmatched.length - 40} 条，见附录 |`);
    out.push('');
  }

  out.push(`## ${unmatched.length ? '二' : '一'}、总览`);
  out.push('');
  out.push(`- 已覆盖 **${t.covered}** 项，有标题无证据 **${t.mentioned}** 项，缺失 **${t.missing}** 项`);
  const tierCount = new Map<string, number>();
  for (const d of result.diagnoses) {
    if (d.tier) tierCount.set(d.tier.label, (tierCount.get(d.tier.label) ?? 0) + 1);
  }
  if (tierCount.size) {
    out.push(
      `- 推定档位：${[...tierCount.entries()].map(([k, v]) => `${k} ${v}`).join('｜')}（依据证据条数）`,
    );
  }
  out.push(`- 废标风险 **${t.rejectRisk}** 条`);
  out.push(`- 章节识别率 ${(result.sectionCoverage * 100).toFixed(0)}%`);
  if (result.missingTopics.length) {
    out.push(
      `- 文中未找到的章节：${result.missingTopics.join('、')}（这些章节的检查项全部判为缺失）`,
    );
  }
  out.push('');

  const ordered = [...result.diagnoses].sort(
    (a, b) => rankOf(a) - rankOf(b) || a.checkId.localeCompare(b.checkId),
  );
  const problems = ordered.filter((d) => d.state !== 'covered');

  out.push(`## ${unmatched.length ? '三' : '二'}、缺项清单（${problems.length} 条）`);
  out.push('');
  if (!problems.length) {
    out.push('（全部检查项都有证据支撑）');
  } else {
    out.push('| 章节 | 检查项 | 状态 | 缺什么 | 建议 |');
    out.push('|---|---|---|---|---|');
    for (const d of problems.slice(0, 60)) {
      const topic = ruleset.topics.find((x) => x.id === d.topicId);
      const advice = d.rejectRisk
        ? '**废标风险，优先补**'
        : d.state === 'mentioned'
          ? '补量化证据（数量/型号/规范号）'
          : '整段缺失';
      out.push(
        `| ${esc(topic?.name ?? d.topicId)} | ${esc(d.title)} | ${STATE_CN[d.state]} | ` +
          `${esc(d.missing.join('；') || '—')} | ${advice} |`,
      );
    }
    if (problems.length > 60) out.push(`| … | 还有 ${problems.length - 60} 条 | | | |`);
  }
  out.push('');

  out.push(`## ${unmatched.length ? '四' : '三'}、覆盖明细`);
  out.push('');
  const covered = ordered.filter((d) => d.state !== 'missing');
  if (!covered.length) {
    out.push('（无）');
  } else {
    out.push('| 检查项 | 状态 | 推定档位 | 证据位置（行号为标书内行） |');
    out.push('|---|---|---|---|');
    for (const d of covered) {
      const ev = d.hits.length
        ? d.hits.map((h) => `L${h.line + 1} ${esc(clip(h.snippet, 28))}`).join('；')
        : '—';
      out.push(
        `| ${esc(d.title)} | ${STATE_CN[d.state]} | ${d.tier ? `${d.tier.label}（${d.hits.length} 项证据）` : '—'} | ${ev} |`,
      );
    }
  }
  out.push('');

  out.push(`## ${unmatched.length ? '五' : '四'}、废标风险（${input.rejects.length} 条条款）`);
  out.push('');
  if (!input.rejects.length) {
    out.push('（本项目评分表里未抽取到符合性/资格评审条款，需人工查阅招标文件）');
  } else {
    out.push('以下是本项目抽取到的废标/否决条款，逐条核对（缺一条即出局）：');
    out.push('');
    for (const r of input.rejects.slice(0, 30)) {
      out.push(`- （p${r.page}）${esc(clip(r.text, 180))}`);
    }
    if (input.rejects.length > 30) out.push(`- ……还有 ${input.rejects.length - 30} 条`);
  }
  out.push('');

  if (input.clarifications.length) {
    const affected = input.clarifications.filter((c) => (c.affects ?? '').includes('评分标准'));
    out.push(`## 六、澄清提示（${input.clarifications.length} 条）`);
    out.push('');
    out.push(
      `> 本项目有 **${input.clarifications.length}** 条澄清问答，其中 **${affected.length}** 条涉及评分标准。`,
    );
    out.push('> 上面的诊断基于**原招标文件**评分表，未合并这些修改 —— 写标前必须逐条核对。');
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('> 说明：本报告由规则库 + 标书文本自动生成，只回答“有没有对应内容、有几项证据”。');
  out.push('> 它不预测得分，也不判断方案是否合理 —— 那需要人。');
  out.push(
    input.hasFullText
      ? '> 评分标准原文已用放宽截断的版本（scoring_item_full），档位阈值可读。'
      : '> 本项目尚未回填 scoring_item_full，评分标准原文可能被 200 字截断，档位需人工核对。',
  );

  return out.join('\n');
}

export function buildJson(input: ReportInput): unknown {
  const t = tally(input.result.diagnoses);
  return {
    bid: {
      path: input.bid.path,
      chars: input.bid.chars,
      sections: input.bid.sections.map((s) => ({
        title: s.title,
        topicId: s.topicId,
        startLine: s.startLine + 1,
        endLine: s.endLine + 1,
      })),
      unsegmented: input.bid.unsegmented,
    },
    tender: input.tender,
    rules: { version: input.ruleset.schemaVersion, hash: input.ruleset.hash },
    summary: {
      ...t,
      sectionCoverage: Number(input.result.sectionCoverage.toFixed(3)),
      scoreItems: input.scoreItems.length,
      timeouts: input.result.timeouts,
      missingTopics: input.result.missingTopics,
    },
    diagnoses: input.result.diagnoses.map((d) => ({
      checkId: d.checkId,
      topicId: d.topicId,
      title: d.title,
      state: d.state,
      tier: d.tier,
      rejectRisk: d.rejectRisk,
      hits: d.hits.map((h) => ({ kind: h.kind, pattern: h.pattern, line: h.line + 1, snippet: h.snippet })),
      missing: d.missing,
    })),
    unmatchedScoreItems: matchScoreItems(input)
      .filter((m) => !m.check)
      .map((m) => ({ page: m.item.page, text: m.item.text })),
  };
}
