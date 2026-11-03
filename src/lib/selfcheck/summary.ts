/**
 * 行动清单：把 200+ 行的自检报告压成「先改这几件」。
 *
 * 为什么需要：报告本身是给人逐条核的，但**投标前时间紧，人只会看最前面几行**。
 * 如果前 10 行是「覆盖 147 条」这种统计，等于没说。
 *
 * 排序按后果严重性，不按规则顺序：
 *   会废标 → 清单要求但没写 → 章节体量不足 → 关键章节缺失 → 有标题无证据 → 规范漏引
 *
 * 输出分两层：
 *   buildActions()     → 结构化数据（Markdown 报告与前端面板共用，避免两边算得不一样）
 *   renderActionList() → 渲染成 Markdown
 */

import { loadSchemeOutline } from '../boq-signal.ts';
import type { ProjectContext } from '../project-context.ts';
import type { DiagnoseResult } from './diagnose.ts';
import type { Ruleset } from './types.ts';

const MAX_PER_GROUP = 5;

export type ActionKey = 'reject' | 'boq' | 'volume' | 'section' | 'mentioned' | 'standard';

export interface ActionItem {
  /** 规则 id 或方案名 */
  id: string;
  title: string;
  /** 缺什么 / 门槛 / 关键词 */
  detail?: string;
  /** 清单项数 */
  count?: number;
  /** 建议分段 */
  segs?: string[];
  /** 证据行号（0 基） */
  line?: number;
  /** 章节级检查：去重后字数 */
  bodyChars?: number;
  /** 章节级检查：门槛 */
  minChars?: number;
}

export interface ActionGroup {
  key: ActionKey;
  label: string;
  mark: string;
  items: ActionItem[];
  /** 该组的完整条数（items 可能被截断到 MAX_PER_GROUP） */
  total: number;
}

export interface Actions {
  groups: ActionGroup[];
  /** 前四类（会废标 + 清单缺 + 体量 + 章节缺失）的总数，0 表示没有硬伤 */
  hard: number;
}

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

export function buildActions(diag: DiagnoseResult, ctx: ProjectContext | null, ruleset: Ruleset): Actions {
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

  const raw: ActionGroup[] = [
    {
      key: 'reject',
      label: '会废标',
      mark: '🔴',
      total: reject.length,
      items: reject.map((d) => ({
        id: d.checkId,
        title: d.title,
        detail: d.missing[0] ? `缺：${d.missing[0]}` : '未见相应内容',
        line: d.hits[0]?.line,
      })),
    },
    {
      key: 'boq',
      label: '清单要求但标书没写',
      mark: '🟠',
      total: boqMiss.length,
      items: boqMiss.map((c) => ({
        id: c.scheme,
        title: c.scheme,
        count: boqCount.get(c.scheme),
        segs: outline.get(c.scheme),
      })),
    },
    {
      key: 'volume',
      label: '章节体量不足',
      mark: '🟡',
      total: volumeShort.length,
      items: volumeShort.map((d) => {
        const c = byId.get(d.checkId);
        return {
          id: d.checkId,
          title: d.title,
          bodyChars: d.bodyChars ?? 0,
          minChars: c?.evidence.find((e) => e.kind === 'volume')?.minChars,
          line: d.hits[0]?.line,
        };
      }),
    },
    {
      key: 'section',
      label: '关键章节缺失',
      mark: '🟡',
      total: sectionMissing.length,
      items: diversify(sectionMissing, MAX_PER_GROUP).map((d) => ({
        id: d.checkId,
        title: d.title,
        detail: d.missing[0],
        line: d.hits[0]?.line,
      })),
    },
    {
      key: 'mentioned',
      label: '有标题无证据',
      mark: '⚪',
      total: mentioned.length,
      items: mentioned.slice(0, MAX_PER_GROUP).map((d) => ({ id: d.checkId, title: d.title, line: d.hits[0]?.line })),
    },
    {
      key: 'standard',
      label: '规范漏引',
      mark: '⚪',
      total: stdMiss.length,
      items: stdMiss.map((code) => ({ id: code, title: code })),
    },
  ].filter((g) => g.total > 0);
  const groups: ActionGroup[] = raw;

  const hard = reject.length + boqMiss.length + volumeShort.length + sectionMissing.length;
  return { groups, hard };
}

function groupMarkdown(g: ActionGroup): string[] {
  const out: string[] = [];
  out.push(`## ${g.mark} ${g.label}（${g.total}）`);
  out.push('');
  for (const it of g.items) {
    if (g.key === 'boq') {
      const seg = it.segs?.length ? ` — 建议分段：${it.segs.join(' · ')}` : '';
      out.push(`- **${it.title}**${it.count ? `（清单 ${it.count} 项）` : ''}${seg}`);
    } else if (g.key === 'volume') {
      out.push(
        `- **${it.title}** — 去重后 ${(it.bodyChars ?? 0).toLocaleString('zh-CN')} 字` +
          (it.minChars ? ` / 门槛 ${it.minChars}` : ''),
      );
    } else if (g.key === 'mentioned' || g.key === 'standard') {
      // 这两类只列名字，不逐条加粗（数量多，加粗反而噪音）
      continue;
    } else {
      out.push(`- **${it.title}**${it.detail ? ` — ${it.detail}` : ''}`);
    }
  }
  if (g.key === 'mentioned') out.push(`- ${g.items.map((x) => x.title).join('、')}`);
  if (g.key === 'standard') out.push(`- ${g.items.map((x) => x.title).join('、')}`);
  if (g.total > g.items.length) out.push(`- …还有 ${g.total - g.items.length} 条，见下文`);
  out.push('');
  return out;
}

export function renderActionList(input: {
  diag: DiagnoseResult;
  ctx: ProjectContext | null;
  ruleset: Ruleset;
  totalLines: number;
}): string {
  const actions = buildActions(input.diag, input.ctx, input.ruleset);
  if (actions.groups.length === 0) return '';

  const out: string[] = [];
  out.push('# 先改这些');
  out.push('');
  out.push(
    `> 全文 ${input.totalLines.toLocaleString('zh-CN')} 行。这里按**后果严重性**排序，只列必须先动的；` +
      `规则覆盖、工期态势、规范明细在各节正文。`,
  );
  out.push('');
  for (const g of actions.groups) out.push(...groupMarkdown(g));
  out.push('---');
  out.push('');

  return out.join('\n');
}
