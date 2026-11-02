/**
 * 自检器回归：跑 4 份 fixture，断言关键性质，列出"死规则"。
 *
 * 为什么需要它：规则库改动（加一条 term、调一个档位）可能让空话标重新变成全绿，
 * 也可能让全覆盖标出现漏检。这两件事都必须在一个命令里被抓住。
 *
 * 断言（任何一条不满足即退出码 1）：
 *   1. full         覆盖 ≥ 90%（漏检控制）
 *   2. ai-emptytalk 覆盖 = 0  （误报控制，最重要）
 *   3. no-heading   必须标记 unsegmented（降级而不是崩溃）
 *   4. partial      缺失 ≥ 15 条（缺项检出）
 *
 * 用法：node --no-warnings src/eval/run-eval.ts
 */

import { join } from 'node:path';

import { prepare } from '../lib/bid-text.ts';
import { diagnose, tally } from '../lib/selfcheck/diagnose.ts';
import { loadRules } from '../lib/selfcheck/rules.ts';

const DIR = join('test', 'fixtures', 'bid');

const { ruleset, issues } = loadRules();
if (!ruleset) {
  for (const i of issues) console.error(`[error] ${i.where} ${i.message}`);
  process.exit(2);
}

const headings = ruleset.topics.map((t) => ({ topicId: t.id, aliases: t.headings }));
const total = ruleset.checks.length;

interface Row {
  name: string;
  covered: number;
  mentioned: number;
  missing: number;
  unsegmented: boolean;
  hitIds: Set<string>;
}

const rows: Row[] = [];
for (const name of ['full', 'partial', 'no-heading', 'ai-emptytalk']) {
  const doc = prepare(join(DIR, `${name}.md`), headings);
  const r = diagnose(doc, ruleset);
  const t = tally(r.diagnoses);
  rows.push({
    name,
    covered: t.covered,
    mentioned: t.mentioned,
    missing: t.missing,
    unsegmented: doc.unsegmented,
    hitIds: new Set(r.diagnoses.filter((d) => d.hits.length > 0).map((d) => d.checkId)),
  });
}

// ---- 输出 ----
console.log(`规则 ${total} 条（hash=${ruleset.hash}）\n`);
console.log('| fixture | covered | mentioned | missing | 章节 |');
console.log('|---|---|---|---|---|');
for (const r of rows) {
  console.log(
    `| ${r.name} | ${r.covered} | ${r.mentioned} | ${r.missing} | ${r.unsegmented ? '未识别（降级）' : '正常'} |`,
  );
}

// 死规则：在 full 里都没命中 → 这条规则要么写错，要么永远不会生效
const full = rows.find((r) => r.name === 'full')!;
const dead = ruleset.checks.filter((c) => !full.hitIds.has(c.id));
if (dead.length) {
  console.log(`\n死规则 ${dead.length} 条（full 里也未命中，需检查 evidence 或删掉）：`);
  for (const d of dead) console.log(`  ${d.id} ${d.title}  evidence=${d.evidence.map((e) => e.pattern).join('；')}`);
} else {
  console.log('\n无死规则：全部检查项在 full 中都至少命中一项证据。');
}

// ---- 断言 ----
const failures: string[] = [];
const byName = new Map(rows.map((r) => [r.name, r]));

if (full.covered < Math.ceil(total * 0.9)) {
  failures.push(`full 覆盖率 ${full.covered}/${total}，低于 90%（漏检过多）`);
}
const empty = byName.get('ai-emptytalk')!;
if (empty.covered !== 0) {
  failures.push(`ai-emptytalk 有 ${empty.covered} 条被判已覆盖（空话标必须 0，否则自检器会骗人）`);
}
const noHead = byName.get('no-heading')!;
if (!noHead.unsegmented) {
  failures.push('no-heading 未标记 unsegmented（降级逻辑失效）');
}
const partial = byName.get('partial')!;
if (partial.missing < 15) {
  failures.push(`partial 只检出 ${partial.missing} 条缺失，低于 15（缺项检出能力不足）`);
}

if (failures.length) {
  console.log(`\n断言失败 ${failures.length} 条：`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}

console.log('\n全部断言通过：');
console.log(`  ✓ full 覆盖 ${full.covered}/${total}`);
console.log(`  ✓ ai-emptytalk 覆盖 0（零误报）`);
console.log(`  ✓ no-heading 正确降级`);
console.log(`  ✓ partial 检出 ${partial.missing} 条缺失 / ${partial.mentioned} 条有标题无证据`);
