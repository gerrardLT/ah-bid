/**
 * 行动清单：把 200+ 行的自检报告压成「先改这几件」。
 *
 * 为什么需要：报告本身是给人逐条核的，但**投标前时间紧，人只会看最前面几行**。
 * 如果前 10 行是「覆盖 147 条」这种统计，等于没说。
 *
 * 排序按后果严重性，不按规则顺序：
 *   会废标 → 清单要求但没写 → 章节体量不足 → 关键章节缺失 → 有标题无证据 → 规范漏引
 *
 * 每类最多列 5 条，其余写「还有 N 条见下文」—— 摘要的作用是让人知道先动哪儿，
 * 不是替代正文。
 */

import { loadSchemeOutline } from '../boq-signal.ts';
import type { ProjectContext } from '../project-context.ts';
import type { DiagnoseResult } from './diagnose.ts';
import type { Ruleset } from './types.ts';

const MAX_PER_GROUP = 5;

/**
 * 同一主题只取一条，让摘要覆盖更多主题。
 * 否则「关键章节缺失」前 5 条可能全是「引用国家标准/行业标准/地方标准」——
 * 那是同一个主题下的 3 条规则，用户看不出真正缺的是哪一块。
 */
function diversify<T extends { topicId: string }>(list: T[], max: number): T[] {
  const out: T[] = [];
  const used = new Set<string>();
  for (const d of list) {
    if (used.has(d.topicId)) continue;
    used.add(d.topicId);
    out.push(d);
    if (out.length >= max) return out;
  }
  for (const d of list) {
    if (out.includes(d)) continue;
    out.push(d);
    if (out.length >= max) break;
  }
  return out;
}

function group(title: string, mark: string, items: string[], total: number): string[] {
  if (items.length === 0) return [];
  const out: string[] = [];
  out.push(`## ${mark} ${title}（${total}）`);
  out.push('');
  for (const it of items.slice(0, MAX_PER_GROUP)) out.push(`- ${it}`);
  if (total > MAX_PER_GROUP) out.push(`- …还有 ${total - MAX_PER_GROUP} 条，见下文`);
  out.push('');
  return out;
}

export function renderActionList(input: {
  diag: DiagnoseResult;
  ctx: ProjectContext | null;
  ruleset: Ruleset;
  totalLines: number;
}): string {
  const { diag, ctx, ruleset } = input;
  const byId = new Map(ruleset.checks.map((c) => [c.id, c]));

  // 1) 废标风险：规则标了 reject_if_missing 但一条证据都没命中
  const reject = diag.diagnoses.filter((d) => d.rejectRisk);

  // 2) 清单要求但标书没写（含「仅别处提及」）
  const boqMiss = (ctx?.boq?.coverage ?? []).filter((c) => !c.covered);
  const boqCount = new Map((ctx?.boq?.schemes ?? []).map((s) => [s.scheme, s.count]));
  const outline = loadSchemeOutline();

  // 3) 章节体量不足 / 关键章节缺失
  const volumeShort = diag.diagnoses.filter((d) => d.state === 'missing' && d.bodyChars !== undefined);
  const sectionMissing = diag.diagnoses.filter((d) => d.state === 'missing' && d.bodyChars === undefined);

  // 4) 有标题无证据
  const mentioned = diag.diagnoses.filter((d) => d.state === 'mentioned');

  // 5) 规范漏引
  const stdMiss = ctx?.standards.missingCore ?? [];

  const total = reject.length + boqMiss.length + volumeShort.length + sectionMissing.length;
  if (total === 0 && mentioned.length === 0 && stdMiss.length === 0) return '';

  const out: string[] = [];
  out.push('# 先改这些');
  out.push('');
  out.push(
    `> 全文 ${input.totalLines.toLocaleString('zh-CN')} 行。这里按**后果严重性**排序，只列必须先动的；` +
      `规则覆盖、工期态势、规范明细在各节正文。`,
  );
  out.push('');

  out.push(
    ...group(
      '会废标',
      '🔴',
      reject.map((d) => {
        const miss = d.missing[0] ? `缺：${d.missing[0]}` : '未见相应内容';
        return `**${d.title}** — ${miss}`;
      }),
      reject.length,
    ),
  );

  out.push(
    ...group(
      '清单要求但标书没写',
      '🟠',
      boqMiss.map((c) => {
        const n = boqCount.get(c.scheme);
        const seg = outline.get(c.scheme);
        return (
          `**${c.scheme}**${n ? `（清单 ${n} 项）` : ''}` +
          (seg ? ` — 建议分段：${seg.join(' · ')}` : '')
        );
      }),
      boqMiss.length,
    ),
  );

  out.push(
    ...group(
      '章节体量不足',
      '🟡',
      volumeShort.map((d) => {
        const c = byId.get(d.checkId);
        const min = c?.evidence.find((e) => e.kind === 'volume')?.minChars;
        const chars = d.bodyChars ?? 0;
        return `**${d.title}** — 去重后 ${chars.toLocaleString('zh-CN')} 字${min ? ` / 门槛 ${min}` : ''}`;
      }),
      volumeShort.length,
    ),
  );

  out.push(
    ...group(
      '关键章节缺失',
      '🟡',
      diversify(sectionMissing, MAX_PER_GROUP).map(
        (d) => `**${d.title}**${d.missing[0] ? ` — 缺：${d.missing[0]}` : ''}`,
      ),
      sectionMissing.length,
    ),
  );

  if (mentioned.length) {
    out.push(`## ⚪ 有标题无证据（${mentioned.length}）`);
    out.push('');
    out.push(
      `- ${mentioned
        .slice(0, MAX_PER_GROUP)
        .map((d) => d.title)
        .join('、')}`,
    );
    if (mentioned.length > MAX_PER_GROUP) out.push(`- …还有 ${mentioned.length - MAX_PER_GROUP} 条，见下文`);
    out.push('');
  }

  if (stdMiss.length) {
    out.push(`## ⚪ 规范漏引（${stdMiss.length}）`);
    out.push('');
    out.push(`- ${stdMiss.join('、')}`);
    out.push('');
  }

  out.push('---');
  out.push('');

  return out.join('\n');
}
