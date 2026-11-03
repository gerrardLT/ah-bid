/**
 * 澄清主题词表的构建与审计 CLI。
 *
 * 用法：
 *   node --no-warnings src/qa-topics.ts --build           # 全量统计 + 未归类样本
 *   node --no-warnings src/qa-topics.ts --build --top=50  # 未归类样本条数
 *
 * 输出什么：
 *   1. 每个主题命中多少条问题、覆盖多少个项目 —— 告诉专家先给哪些主题写规则
 *   2. 未归类的样本（按出现项目数排序，不是按条数）—— 下一批该加什么词
 *   3. 极性分布 —— 招标人的答复里有多少是"不认可"
 *
 * 这是只读工具，不写任何表。
 */

import { DatabaseSync } from 'node:sqlite';

import { classifyQa, dedupeQuestions, loadQaTopics } from './lib/qa-topics.ts';

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const TOP = Number(argOf('top') ?? 20);

const topics = loadQaTopics();
const db = new DatabaseSync('data/index.db', { readOnly: true });

const raw = db
  .prepare('SELECT announcement_guid AS ag, question, answer FROM clarification_qa')
  .all() as Array<{ ag: string; question: string | null; answer: string | null }>;
const rows = dedupeQuestions(raw);

console.log(
  `主题词表 ${topics.length} 个｜澄清原始 ${raw.length} 条，去重后 ${rows.length} 条｜覆盖项目 ${new Set(rows.map((r) => r.ag)).size} 个\n`,
);

// ---- 分类 ----
const stat = new Map<string, { q: number; projects: Set<string>; scoring: number }>();
const polarity = { neg: 0, pos: 0, defer: 0, unknown: 0 };
const unclassified: Array<{ q: string; ag: string }> = [];
const perProject = new Map<string, Set<string>>();

for (const r of rows) {
  const c = classifyQa(r.question ?? '', r.answer ?? '', topics);
  polarity[c.polarity] += 1;
  if (c.topics.length === 0) {
    unclassified.push({ q: (r.question ?? '').slice(0, 100), ag: r.ag });
    continue;
  }
  for (const t of c.topics) {
    const s = stat.get(t) ?? { q: 0, projects: new Set(), scoring: 0 };
    s.q += 1;
    s.projects.add(r.ag);
    if (c.scoring) s.scoring += 1;
    stat.set(t, s);
    if (!perProject.has(r.ag)) perProject.set(r.ag, new Set());
    perProject.get(r.ag)!.add(t);
  }
}

console.log('=== 主题分布（按覆盖项目数排序）===');
const ordered = [...stat.entries()].sort((a, b) => b[1].projects.size - a[1].projects.size);
for (const [id, s] of ordered) {
  const name = topics.find((t) => t.id === id)?.name ?? id;
  const pct = ((s.q / rows.length) * 100).toFixed(1);
  console.log(
    `  ${id.padEnd(14)} ${name.padEnd(8)} 问题 ${String(s.q).padStart(5)} 条（${pct}%）` +
      `  覆盖 ${String(s.projects.size).padStart(3)} 个项目  涉评分 ${s.scoring}`,
  );
}

const hit = rows.length - unclassified.length;
console.log(
  `\n命中率 ${((hit / rows.length) * 100).toFixed(1)}%（${hit}/${rows.length}），` +
    `未归类 ${unclassified.length} 条（${((unclassified.length / rows.length) * 100).toFixed(1)}%）`,
);

console.log(
  `\n=== 答复极性 ===\n  否定 ${polarity.neg}｜肯定 ${polarity.pos}｜按文件执行 ${polarity.defer}｜无法判定 ${polarity.unknown}`,
);
if (polarity.neg > 0) {
  console.log('  （否定优先判定：含"不认可/不予认可"的答复不会被算成肯定）');
}

// 未归类里按"出现在多少个项目"排序 —— 一个词在 50 个项目里出现，比在 1 个项目里出现 50 次更值得加
const byProject = new Map<string, Set<string>>();
for (const u of unclassified) {
  const key = u.q.slice(0, 24);
  if (!byProject.has(key)) byProject.set(key, new Set());
  byProject.get(key)!.add(u.ag);
}
console.log(`\n=== 未归类样本 Top${TOP}（按跨越项目数排序）===`);
[...byProject.entries()]
  .sort((a, b) => b[1].size - a[1].size)
  .slice(0, TOP)
  .forEach(([q, ags], i) => {
    console.log(`  ${i + 1}. [${ags.size} 个项目] ${q}`);
  });

console.log(`\n每个项目平均命中 ${(
  [...perProject.values()].reduce((a, s) => a + s.size, 0) / Math.max(perProject.size, 1)
).toFixed(1)} 个主题`);

db.close();
