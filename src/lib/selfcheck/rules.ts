/**
 * 规则加载与语义校验。
 *
 * 分工：compile-rules 挡"格式错"（列缺失、证据写不出正则、孤儿 check_id），
 * 这里挡"内容可疑"（未复核、档位要求超过证据数、空章节）。
 *
 * 错误分两级：error 阻止运行，warn 只提示（如超期未复核）。
 */

import { compileRules } from './compile-rules.ts';
import type { Ruleset } from './types.ts';

export interface RuleIssue {
  where: string;
  message: string;
  severity: 'error' | 'warn';
}

const YEAR_MS = 365 * 24 * 3600 * 1000;

/** 读 CSV 并编译；失败时把 `文件:行号` 拆出来，便于定位 */
export function loadRules(dir = 'rules/v1'): { ruleset: Ruleset | null; issues: RuleIssue[] } {
  try {
    return { ruleset: compileRules(dir), issues: [] };
  } catch (e) {
    const msg = (e as Error).message;
    const m = /^(.*?):(\d+)\s+(.*)$/.exec(msg);
    return {
      ruleset: null,
      issues: [
        {
          where: m ? `${m[1]}:${m[2]}` : dir,
          message: m ? m[3] : msg,
          severity: 'error',
        },
      ],
    };
  }
}

export function validateRules(rs: Ruleset): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const now = Date.now();

  for (const c of rs.checks) {
    if (!c.title) {
      issues.push({ where: `checks.csv:${c.sourceRow}`, message: `${c.id} title 为空`, severity: 'error' });
    }

    const arr = rs.tiers[c.id] ?? [];
    const top = arr.length ? arr[arr.length - 1].minEvidence : 0;
    if (top > c.evidence.length) {
      issues.push({
        where: `checks.csv:${c.sourceRow}`,
        message: `${c.id} 最高档要求 ${top} 项证据，实际只定义 ${c.evidence.length} 项（永远达不到）`,
        severity: 'error',
      });
    }

    const t = Date.parse(c.reviewed);
    if (!Number.isNaN(t) && now - t > YEAR_MS) {
      issues.push({
        where: `checks.csv:${c.sourceRow}`,
        message: `${c.id} 超过 12 个月未复核（${c.reviewed}），建议重新核对评分标准原文`,
        severity: 'warn',
      });
    }
  }

  for (const t of rs.topics) {
    if (!rs.checks.some((c) => c.topicId === t.id)) {
      issues.push({
        where: `topics.csv:${t.sourceRow}`,
        message: `${t.id}（${t.name}）没有任何检查项，暂时不会产出诊断`,
        severity: 'warn',
      });
    }
  }

  return issues;
}

export function summarize(rs: Ruleset): string {
  const tierCount = Object.values(rs.tiers).reduce((a, b) => a + b.length, 0);
  const reject = rs.checks.filter((c) => c.rejectIfMissing).length;
  return (
    `规则 v${rs.schemaVersion} hash=${rs.hash}｜` +
    `${rs.topics.length} 章节 / ${rs.checks.length} 检查项 / ${tierCount} 档位 / ${reject} 废标项`
  );
}
