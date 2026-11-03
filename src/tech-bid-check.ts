/**
 * 技术标自检 CLI。
 *
 * 用法：
 *   node --no-warnings src/tech-bid-check.ts --bid=技术标.docx --title="项目名关键词"
 *   node --no-warnings src/tech-bid-check.ts --bid=技术标.txt --guid=<attach_guid>
 *   node --no-warnings src/tech-bid-check.ts --bid=技术标.txt --out=output/自检.md --json
 *   node --no-warnings src/tech-bid-check.ts --bid=技术标.txt --dump-sections
 *   node --no-warnings src/tech-bid-check.ts --bid=技术标.txt --dump-context --project-type=房建
 *   node --no-warnings src/tech-bid-check.ts --bid=技术标.txt --no-context
 *   node --no-warnings src/tech-bid-check.ts --validate-rules
 *
 * 只给 --bid 也能跑：没有招标文件时降级为「纯章节 + 证据检查」，
 * 不假装知道本项目的评分项（这与 tech-bid.ts「找不到招标文件也能跑」的惯例一致）。
 *
 * `--no-context` 关闭「工程本体信号」（澄清关注点 / 工期态势 / 规范核对），
 * 输出与加入该功能之前**逐字节一致** —— 这是零回归的验收方式。
 *
 * 退出码：0 正常｜1 参数或数据缺失｜2 规则库非法
 * 注意：**不因"有缺项"返回非零** —— 否则批处理会把它当失败。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { prepare, type HeadingRule } from './lib/bid-text.ts';
import { buildProjectContext, type ProjectContext } from './lib/project-context.ts';
import { loadQaTopics } from './lib/qa-topics.ts';
import { renderContextSection } from './lib/selfcheck/context-report.ts';
import { diagnose, tally } from './lib/selfcheck/diagnose.ts';
import { buildJson, renderMarkdown, type ReportInput, type TenderMeta } from './lib/selfcheck/report.ts';
import { loadRules, summarize, validateRules } from './lib/selfcheck/rules.ts';
import {
  loadClarifications,
  loadRejectItems,
  loadScoreItems,
  type Clarification,
  type ScoreRow,
} from './lib/tender-scoring.ts';

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};

const BID = argOf('bid');
const GUID = argOf('guid');
const TITLE = argOf('title');
const OUT = argOf('out');
const AS_JSON = process.argv.includes('--json');
const DUMP = process.argv.includes('--dump-sections');
const VALIDATE = process.argv.includes('--validate-rules');
const DUMP_CTX = process.argv.includes('--dump-context');
const NO_CONTEXT = process.argv.includes('--no-context');
/** 显式指定项目类型才判"强制规范漏引"，自动识别不可靠（实测 35% 落"其他"） */
const PROJECT_TYPE = argOf('project-type') ?? null;

// ---- 1) 规则 ----
const { ruleset, issues } = loadRules();
if (!ruleset) {
  for (const i of issues) console.error(`[error] ${i.where} ${i.message}`);
  process.exit(2);
}
const ruleIssues = validateRules(ruleset);
const ruleErrors = ruleIssues.filter((i) => i.severity === 'error');
if (ruleErrors.length) {
  for (const e of ruleErrors) console.error(`[error] ${e.where} ${e.message}`);
  process.exit(2);
}

if (VALIDATE) {
  console.log(summarize(ruleset));
  for (const w of ruleIssues.filter((i) => i.severity === 'warn')) {
    console.log(`[warn] ${w.where} ${w.message}`);
  }
  process.exit(0);
}

if (!BID) {
  console.log('用法：');
  console.log('  node src/tech-bid-check.ts --bid=技术标.docx --title="项目名关键词"');
  console.log('  node src/tech-bid-check.ts --bid=技术标.docx --guid=<attach_guid>');
  console.log('  node src/tech-bid-check.ts --bid=技术标.docx --out=output/自检.md [--json]');
  console.log('  node src/tech-bid-check.ts --bid=技术标.docx --dump-sections');
  console.log('  node src/tech-bid-check.ts --bid=技术标.docx --dump-context --project-type=房建');
  console.log('  node src/tech-bid-check.ts --bid=技术标.docx --no-context');
  console.log('  node src/tech-bid-check.ts --validate-rules');
  process.exit(1);
}

// ---- 2) 标书文本 ----
const headings: HeadingRule[] = ruleset.topics.map((t) => ({ topicId: t.id, aliases: t.headings }));
let bid;
try {
  bid = prepare(BID, headings);
} catch (e) {
  console.error(`读取标书失败：${(e as Error).message}`);
  process.exit(1);
}

if (DUMP) {
  console.log(
    `章节 ${bid.sections.length} 段${bid.unsegmented ? '（未识别出标题，已降级为整篇检索）' : ''}`,
  );
  for (const s of bid.sections) {
    console.log(`  L${s.startLine + 1}-${s.endLine + 1}  [${s.topicId ?? '-'}]  ${s.title}`);
  }
  process.exit(0);
}

// ---- 3) 招标文件（可选）----
const db = new DatabaseSync(join('data', 'index.db'), { readOnly: true });

let tender: TenderMeta | null = null;
let scoreItems: ScoreRow[] = [];
let rejects: ScoreRow[] = [];
let clarifications: Clarification[] = [];
let hasFullText = false;
let ctx: ProjectContext | null = null;

interface DocRow {
  g: string;
  ag: string;
  pages: number | null;
  score_technical: number | null;
  evaluation_method: string | null;
  score_verified: number;
  title: string;
  city: string | null;
}

if (GUID || TITLE) {
  const sqlBase = `SELECT d.attach_guid g, d.announcement_guid ag, d.pages, d.score_technical,
                          d.evaluation_method, d.score_verified, a.title, a.city
                   FROM tender_doc d JOIN announcement a ON a.guid = d.announcement_guid`;

  const row = (
    GUID
      ? db.prepare(`${sqlBase} WHERE d.attach_guid = ?`).get(GUID)
      : db
          .prepare(`${sqlBase} WHERE a.title LIKE ? ORDER BY d.score_verified DESC, d.pages DESC LIMIT 1`)
          .get(`%${TITLE}%`)
  ) as DocRow | undefined;

  if (!row) {
    console.error(
      `未找到匹配的招标文件解析记录（${GUID ? `guid=${GUID}` : `title=${TITLE}`}），` +
        `本次仅做「章节 + 证据」检查，不判断本项目评分项。`,
    );
  } else {
    tender = {
      title: row.title,
      city: row.city,
      pages: row.pages,
      scoreTechnical: Number(row.score_technical ?? 0),
      evaluationMethod: row.evaluation_method,
      verified: row.score_verified === 1,
    };
    scoreItems = loadScoreItems(db, row.g, { dropReferences: true });
    rejects = loadRejectItems(db, row.g);
    clarifications = loadClarifications(db, row.ag);

    try {
      hasFullText =
        db.prepare('SELECT 1 AS x FROM scoring_item_full WHERE attach_guid = ? LIMIT 1').get(row.g) !==
        undefined;
    } catch {
      hasFullText = false; // 表还没建，正常降级
    }

    if (tender.scoreTechnical <= 0) {
      console.error('提示：该招标文件没有识别出技术标分值（score_technical=0），评分权重未知。');
    }

    // 工程本体信号：必须在 db.close() 之前用同一个句柄（二次开库会 database is locked）
    if (!NO_CONTEXT) {
      try {
        ctx = buildProjectContext(db, bid, {
          announcementGuid: row.ag,
          projectType: PROJECT_TYPE,
          topics: loadQaTopics(),
          clarifications,
        });
      } catch (e) {
        console.error(`[降级] 工程本体信号构建失败，已跳过：${String(e).slice(0, 120)}`);
      }
    }
  }
}
db.close();

if (DUMP_CTX) {
  if (!ctx) {
    console.error('没有可用的工程本体信号（需要 --guid 或 --title，且未加 --no-context）');
    process.exit(1);
  }
  console.log(renderContextSection(ctx));
  process.exit(0);
}

// ---- 4) 诊断 ----
const result = diagnose(bid, ruleset);
const input: ReportInput = {
  bid,
  ruleset,
  result,
  scoreItems,
  rejects,
  clarifications,
  tender,
  hasFullText,
};

// ---- 5) 输出 ----
const text = AS_JSON
  ? JSON.stringify(
      { ...(buildJson(input) as Record<string, unknown>), ...(ctx ? { context: ctx } : {}) },
      null,
      2,
    )
  : renderMarkdown(input) + (ctx ? renderContextSection(ctx) : '');

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  console.log(`已生成：${OUT}`);
} else {
  console.log(text);
}

const t = tally(result.diagnoses);
console.error(
  `\n[统计] ${bid.chars.toLocaleString('zh-CN')} 字｜章节 ${bid.sections.length} 段` +
    `（识别率 ${(result.sectionCoverage * 100).toFixed(0)}%）｜` +
    `覆盖 ${t.covered} / 有标题无证据 ${t.mentioned} / 缺失 ${t.missing}｜废标风险 ${t.rejectRisk}` +
    `｜本项目评分项 ${scoreItems.length} 条｜规则 ${ruleset.checks.length} 条（${ruleset.hash}）`,
);
if (result.timeouts.length) {
  console.error(`[超时] ${result.timeouts.join('、')} —— 这些规则的匹配超出预算，结论可能不完整`);
}
if (ctx) {
  const oldVer = ctx.standards.findings.filter((f) => f.verdict === '有更新版').length;
  console.error(
    `[本体] 关注点 ${ctx.qa.items.length} 个｜工期 ${ctx.schedule.days ?? '—'} 天（${ctx.schedule.level}）｜` +
      `标准 ${ctx.standards.cited} 条（有更新版 ${oldVer}）`,
  );
}
