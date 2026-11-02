/**
 * 由规则库机械生成测试标书。
 *
 * 为什么生成而不是手写：0 份真实样本的前提下，手写 4 份标书必然与规则脱节——
 * 规则一改，fixture 就失去意义。从 evidence 列表反推文本，规则变则文本变，
 * 测试永远测的是"当前规则库能识别什么"。
 *
 * 四份的用途：
 *   full.md         每个检查项的证据都出现 → 测漏检（应该几乎全 covered）
 *   partial.md      缺 2 章、1 章只有标题      → 测缺项检出
 *   no-heading.md   正文齐全但无标题           → 测降级（整篇检索，不崩）
 *   ai-emptytalk.md 章节齐全、零证据           → 测"有标题无证据"（必须全 mentioned）
 *
 * 用法：node --no-warnings src/eval/gen-fixtures.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadRules } from '../lib/selfcheck/rules.ts';
import type { Check } from '../lib/selfcheck/types.ts';

const OUT = join('test', 'fixtures', 'bid');

/** cite / regex 类型的 pattern 是正则，不能直接当文本，给几个常见示例 */
const SAMPLE: Record<string, string> = {
  'GB\\s?\\d{4,5}': 'GB 50204',
  'GB/T\\s?\\d{4,5}': 'GB/T 50300',
  'JGJ\\s?\\d{2,4}': 'JGJ 59',
  'CJJ\\s?\\d{2,4}': 'CJJ 1',
  'DB\\s?34': 'DB34/T 1234',
  'GB\\s?\\d{4,5}-\\d{4}': 'GB 50204-2015',
  '20\\d{2}': '2026',
};

function sampleOf(kind: string, pattern: string): string {
  if (kind === 'volume') return ''; // 章节级证据由 FILLER 单独补足字数
  if (kind === 'cite' || kind === 'regex') return SAMPLE[pattern] ?? pattern;
  if (kind === 'number') return `${pattern} 12000`;
  return pattern;
}

/** 章节级证据的填充正文：约 640 字，覆盖最高的 volume 门槛（500） */
const FILLER =
  '本节按规范要求编制，逐项说明实施思路、过程控制与责任分工，并明确检查节点与记录要求。'.repeat(
    14,
  );

const { ruleset } = loadRules();
if (!ruleset) {
  console.error('规则库非法，先跑 node src/selfcheck-validate.ts');
  process.exit(2);
}

const topicIds = [...new Set(ruleset.checks.map((c) => c.topicId))];
/** 叶子章节：没有子章节的 topic。partial 只删叶子——父级章节被删会让“父级累加”逻辑失去意义 */
const leafIds = topicIds.filter((id) => !ruleset.topics.some((t) => t.parent === id));
const nameOf = (id: string): string => ruleset.topics.find((t) => t.id === id)?.name ?? id;
const checksOf = (id: string): Check[] => ruleset.checks.filter((c) => c.topicId === id);

mkdirSync(OUT, { recursive: true });

// ---- full：全覆盖 ----
const full: string[] = ['# 施工组织设计', ''];
for (const id of topicIds) {
  full.push(`## ${nameOf(id)}`, '');
  const cks = checksOf(id);
  for (const c of cks) {
    const ev = c.evidence
      .filter((e) => e.kind !== 'volume')
      .map((e) => sampleOf(e.kind, e.pattern))
      .join('，');
    // 不把 check.title 写进正文：标题词不等于实质内容，写进去会把空话标也测成全覆盖
    if (ev) full.push(`本工程将${ev}纳入总体部署，并在实施过程中动态调整。`, '');
  }
  // 章节级规则：补足正文字数，否则 L1 会因字数不够而判 mentioned
  if (cks.some((c) => c.evidence.some((e) => e.kind === 'volume'))) full.push(FILLER, '');
}
writeFileSync(join(OUT, 'full.md'), full.join('\n'), 'utf8');

// ---- partial：去掉前 2 个叶子章节，第 3 个只留标题 ----
const partial: string[] = ['# 施工组织设计', ''];
leafIds.forEach((id, idx) => {
  if (idx < 2) return; // 整章缺失
  partial.push(`## ${nameOf(id)}`, '');
  if (idx === 2) return; // 只有标题、没有正文
  const cks = checksOf(id);
  for (const c of cks) {
    const ev = c.evidence
      .filter((e) => e.kind !== 'volume')
      .map((e) => sampleOf(e.kind, e.pattern))
      .join('，');
    if (ev) partial.push(`本工程将${ev}纳入总体部署，并在实施过程中动态调整。`, '');
  }
  if (cks.some((c) => c.evidence.some((e) => e.kind === 'volume'))) partial.push(FILLER, '');
});
writeFileSync(join(OUT, 'partial.md'), partial.join('\n'), 'utf8');

// ---- no-heading：正文齐全但没有标题 ----
const noHeading = full.filter((l) => !l.startsWith('#')).join('\n');
writeFileSync(join(OUT, 'no-heading.md'), noHeading, 'utf8');

// ---- ai-emptytalk：章节齐全、满篇空话、零证据 ----
const EMPTY_TALK = [
  '本项目将高度重视该项工作。',
  '我方将科学组织、精心安排。',
  '各项工作均按计划有序推进。',
  '全体人员按要求到岗履职。',
  '确保工程顺利实施。',
];
const empty: string[] = ['# 施工组织设计', ''];
for (const id of topicIds) {
  empty.push(`## ${nameOf(id)}`, '');
  // 不用 Math.random：fixture 必须可复现，否则同一规则库两次生成的文件不同
  let k = 0;
  for (const c of checksOf(id)) {
    empty.push(EMPTY_TALK[k++ % EMPTY_TALK.length], '');
  }
}
writeFileSync(join(OUT, 'ai-emptytalk.md'), empty.join('\n'), 'utf8');

const stat = {
  topics: topicIds.length,
  checks: ruleset.checks.length,
  fullLines: full.length,
  hash: ruleset.hash,
};
console.log(`已生成 4 份 fixture → ${OUT}`);
console.log(`  规则 ${stat.checks} 条 / ${stat.topics} 章节（hash=${stat.hash}）`);
console.log('  full.md / partial.md / no-heading.md / ai-emptytalk.md');
