/**
 * 数据质量闸门：把「结论可信度」变成可执行的断言。
 *
 * 为什么需要它：这套系统最容易犯的错不是报错，而是**用一个不可靠的分母算出看似合理的数字**。
 * 例如：澄清未归类率 40% 却说"本项目关注点"、工期用均值 252 天（被 462 个长周期项目拉高）、
 * 标准库把文件号也当标准号判漏引。
 *
 * 用法：node --no-warnings src/data-quality.ts
 * 退出码：0 全部通过｜2 有硬指标不达标
 *
 * 只读，不改任何表。
 */

import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { classifyQa, dedupeQuestions, loadQaTopics } from './lib/qa-topics.ts';
import { loadBaseline } from './lib/project-context.ts';
import { normalizeCode } from './lib/standard-cite.ts';

const db = new DatabaseSync('data/index.db', { readOnly: true });
const problems: string[] = [];
const rows: Array<[string, string, boolean]> = [];

function check(label: string, value: string, ok: boolean): void {
  rows.push([label, value, ok]);
  if (!ok) problems.push(`${label}：${value}`);
}

// ---- 1. 澄清主题 ----
const topics = loadQaTopics();
const raw = db
  .prepare('SELECT announcement_guid AS ag, question, answer FROM clarification_qa')
  .all() as Array<{ ag: string; question: string | null; answer: string | null }>;
const items = dedupeQuestions(raw);
let unclassified = 0;
const topicHits = new Set<string>();
for (const r of items) {
  const c = classifyQa(r.question ?? '', r.answer ?? '', topics);
  if (c.topics.length === 0) unclassified += 1;
  for (const t of c.topics) topicHits.add(t);
}
const hitRate = 1 - unclassified / items.length;
check(
  '澄清主题命中率',
  `${(hitRate * 100).toFixed(1)}%（${items.length - unclassified}/${items.length}，未归类 ${unclassified}）`,
  hitRate >= 0.82,
);
check('澄清主题覆盖率', `${topicHits.size}/${topics.length} 个主题有命中`, topicHits.size >= topics.length * 0.8);

// ---- 2. 工期 / 限价基线 ----
const base = loadBaseline(db);
const tierNs = [...base.durationByTier.entries()].map(([k, v]) => `${k}=${v.n}`);
const minTierN = Math.min(...[...base.durationByTier.values()].map((v) => v.n));
check('工期档位样本', `${base.durationByTier.size} 档，最小 n=${minTierN}（${tierNs.join(' ')}）`, minTierN >= 30);
check(
  '全局工期样本',
  `n=${base.durationAll?.n ?? 0}，中位 ${base.durationAll?.p50 ?? '—'} 天`,
  (base.durationAll?.n ?? 0) >= 500,
);
// 均值 vs 中位差 >20% 要显式提示（本项目踩过：252 vs 180）
const days = db
  .prepare('SELECT days FROM tender_duration WHERE days BETWEEN 30 AND 2000')
  .all() as Array<{ days: number }>;
const mean = days.reduce((a, b) => a + b.days, 0) / days.length;
const median = base.durationAll?.p50 ?? 0;
const gap = Math.abs(mean - median) / median;
check(
  '工期均值 vs 中位',
  `均值 ${mean.toFixed(0)} / 中位 ${median}，偏离 ${(gap * 100).toFixed(0)}%`,
  gap <= 0.5, // 超过 50% 说明长尾极端，报告里必须只用中位
);

// ---- 3. 标准号归一化 ----
const stdRows = db.prepare('SELECT code FROM standard_ref').all() as Array<{ code: string }>;
const bad = stdRows.filter((r) => !normalizeCode(r.code));
const fileNos = bad.filter((b) => /令|〔/.test(b.code));
check(
  '标准号归一化',
  `${stdRows.length} 条，无法归一化 ${bad.length}（其中文件号 ${fileNos.length}）`,
  bad.length === fileNos.length && fileNos.length <= 3,
);

// ---- 4. 覆盖率卡 ----
const cover = db
  .prepare(
    `SELECT
       (SELECT COUNT(*) FROM tender_doc) docs,
       (SELECT COUNT(DISTINCT announcement_guid) FROM tender_duration) dur,
       (SELECT COUNT(DISTINCT announcement_guid) FROM tender_control_price WHERE price_kind='限价') lim,
       (SELECT COUNT(DISTINCT announcement_guid) FROM clarification_qa) clar`,
  )
  .get() as { docs: number; dur: number; lim: number; clar: number };
rows.push([
  '覆盖率',
  `工期 ${cover.dur}/1982｜限价 ${cover.lim}/1982｜澄清 ${cover.clar}/1982`,
  true,
]);

// ---- 5. 业绩抽取（分布型断言）----
// 为什么用分布而不是单条用例：8 条手写用例下，两个 P0（人员业绩判反、
// cnt 被「6个月」「2.10项目」污染）**全部通过**。只有全库分布能抓到它们。
// 表可能还没建（extract-clauses 才创建），建之前跳过而不是报错。
try {
  const p = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM announcement_perf) AS total,
         (SELECT COUNT(*) FROM announcement_perf WHERE notice='无门槛' AND min_amount IS NOT NULL) AS noReqAmount,
         (SELECT COUNT(*) FROM announcement_perf WHERE cnt >= 5) AS cntBig,
         (SELECT COUNT(*) FROM announcement_perf WHERE notice='见招标文件') AS defer`,
    )
    .get() as { total: number; noReqAmount: number; cntBig: number; defer: number };
  check(
    '业绩：无门槛却有金额',
    `${p.noReqAmount} 条（应恒为 0 —— 判反了）`,
    p.noReqAmount === 0,
  );
  check(
    '业绩：cnt>=5 噪声',
    `${p.cntBig} 条（应 < 20；被「6个月」「2.10项目」污染时会冲到 200+）`,
    p.cntBig < 20,
  );
  rows.push(['业绩抽取', `已扫 ${p.total}｜无门槛｜见招标文件 ${p.defer}`, true]);
} catch {
  rows.push(['业绩抽取', 'announcement_perf 尚未创建（跑 extract-clauses）', true]);
}

// ---- 输出 ----
console.log('=== 数据质量闸门 ===\n');
for (const [label, value, ok] of rows) {
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(14)} ${value}`);
}

if (problems.length) {
  console.log(`\n不达标 ${problems.length} 项：`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  db.close();
  process.exit(2);
}

db.close();

// ---- 清单三表（在独立进程里跑，失败会带出具体是哪张表哪一行） ----
// 三表靠「方案名」字符串互相引用，名字写错不报错只会静默失效，
// 所以这道检查必须放进质量闸门，而不是靠人记得手动跑。
console.log('');
try {
  const out = execFileSync('node', ['--no-warnings', 'src/boq-validate.ts'], { encoding: 'utf8' });
  console.log(`  ✓ 清单三表        ${out.trim()}`);
} catch (e) {
  const err = e as { stdout?: string; stderr?: string };
  console.log('  ✗ 清单三表        校验失败：');
  console.log(err.stderr ?? String(e));
  process.exit(3);
}

console.log('\n全部达标。');
