/**
 * 按招标文件生成「评标办法与评分细则」拆解 + 应标策略。
 *
 * 数据来源：tender_doc（评标办法、四维分值）+ scoring_item（表格内容）
 *
 * 关键认知：scoring_item 46,087 行里只有 12.3% 是真评分表，
 * 另有 4.3% 是符合性/资格评审标准（废标条款）——后者比得分更致命，
 * 剩下 83.4% 是投标人须知前附表（开标程序、文件递交等），与评分无关。
 * 所以生成时必须分类，不能把前附表当评分细则列出来。
 *
 * 用法：
 *   node --no-warnings src/tech-bid-scoring.ts --title="铜陵市义安区2026年学前教育"
 *   node --no-warnings src/tech-bid-scoring.ts --guid=<attach_guid>
 *   node --no-warnings src/tech-bid-scoring.ts --title="..." --out=output/评分拆解.md
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  dedup,
  loadClarifications,
  loadRejectItems,
  loadScoreItems,
  SCORE_COND,
  scoreOf,
} from './lib/tender-scoring.ts';

const DATA = 'data';
const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};

// 评分项/废标项的过滤条件与文本还原已抽到 src/lib/tender-scoring.ts，
// 自检器（tech-bid-check）复用同一份实现，避免出现第二套 SCORE_COND 口径。

const db = new DatabaseSync(join(DATA, 'index.db'), { readOnly: true });

const guid = argOf('guid');
const title = argOf('title');
const outArg = argOf('out');

if (!guid && !title) {
  console.log('用法：');
  console.log('  node src/tech-bid-scoring.ts --title="项目名称关键词"');
  console.log('  node src/tech-bid-scoring.ts --guid=<attach_guid>');
  process.exit(1);
}

const doc = (guid
  ? db
      .prepare(
        `SELECT d.*, a.title, a.city FROM tender_doc d JOIN announcement a ON a.guid = d.announcement_guid WHERE d.attach_guid = ?`,
      )
      .get(guid)
  : db
      .prepare(
        `SELECT d.*, a.title, a.city FROM tender_doc d JOIN announcement a ON a.guid = d.announcement_guid
         WHERE a.title LIKE ?
         ORDER BY d.score_verified DESC,
                  (SELECT COUNT(*) FROM scoring_item s WHERE s.attach_guid=d.attach_guid AND (${SCORE_COND})) DESC
         LIMIT 1`,
      )
      .get(`%${title}%`)) as Record<string, unknown> | undefined;

// 澄清文件里的问答（可能改了评分标准——不核对就会按过时规则写标）
const clar = doc ? loadClarifications(db, doc.announcement_guid as string) : [];

if (!doc) {
  console.log(`未找到匹配的招标文件解析记录：${guid ?? title}`);
  process.exit(1);
}

const g = doc.attach_guid as string;
// 读取实现见 src/lib/tender-scoring.ts：默认不过滤引用型条目，
// 保持与既有产物完全一致（只有自检器传 dropReferences: true）。
const scoreItems = loadScoreItems(db, g);
const rejectItems = loadRejectItems(db, g);

db.close();

const scores = dedup(scoreItems);
const rejects = dedup(rejectItems);

const t = Number(doc.score_technical ?? 0);
const c = Number(doc.score_commercial ?? 0);
const p = Number(doc.score_price ?? 0);
const cr = Number(doc.score_credit ?? 0);
const sum = t + c + p + cr;

const out: string[] = [];
out.push(`# 评标办法与评分细则拆解`);
out.push('');
out.push(`> 项目：${doc.title}`);
out.push(`> 地区：${doc.city ?? '-'}｜招标文件 ${doc.pages ?? '?'} 页｜解析置信度：${doc.score_verified ? '分值已验证' : '未验证'}`);
out.push('');

out.push(`## 一、评标办法与分值构成`);
out.push('');
out.push(`评标办法：**${doc.evaluation_method ?? '未识别'}**`);
out.push('');
if (sum > 0) {
  out.push('| 维度 | 分值 | 占比 |');
  out.push('|---|---|---|');
  const rows: Array<[string, number]> = [
    ['技术标', t],
    ['商务标', c],
    ['报价', p],
    ['信用标', cr],
  ];
  for (const [k, v] of rows) {
    if (v > 0) out.push(`| ${k} | ${v} | ${((v / sum) * 100).toFixed(1)}% |`);
  }
  out.push(`| **合计** | **${sum}** | 100% |`);
} else {
  out.push('（分值构成未识别，需人工核对招标文件评标办法章节）');
}
out.push('');

// 策略提示 —— 按分值权重给优先级，这是投标决策的直接依据
out.push(`## 二、应标策略提示`);
out.push('');
if (sum > 0) {
  const ranked = [
    { k: '报价', v: p },
    { k: '技术标', v: t },
    { k: '商务标', v: c },
    { k: '信用标', v: cr },
  ]
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v);

  out.push(`按分值权重排序：**${ranked.map((x) => `${x.k}(${x.v}分)`).join(' > ')}**`);
  out.push('');
  const top = ranked[0];
  const topPct = (top.v / sum) * 100;
  if (topPct >= 50) {
    out.push(`- **${top.k}是胜负手**：占 ${topPct.toFixed(0)}%，超出绝对多数，其余维度只求不失分`);
  } else {
    out.push(`- **${top.k}权重最高**（${topPct.toFixed(0)}%），但未过半，需与其他维度并重`);
  }
  if (p / sum >= 0.4) out.push(`- 报价占 ${((p / sum) * 100).toFixed(0)}%，需提前测算评标基准价与下浮策略`);
  if (t / sum >= 0.3) out.push(`- 技术标占 ${((t / sum) * 100).toFixed(0)}%，是拉开差距的主要空间，编制质量直接决定名次`);
  if (cr > 0) out.push(`- 信用标 ${cr} 分属资质材料项，提前准备信用评价、奖项、体系认证等证明材料`);
  if (rejects.length) out.push(`- **有 ${rejects.length} 条废标条款，优先核对**——废标不得分，比丢分严重得多`);
  out.push('');
}

out.push(`## 三、废标/否决投标风险点（${rejects.length} 条）`);
out.push('');
if (rejects.length) {
  out.push('以下条目来自招标文件的符合性评审/资格评审标准，逐条核对：');
  out.push('');
  rejects.forEach((r, i) => out.push(`${i + 1}. （p${r.page}）${r.text}`));
  if (rejects.length < 5) {
    out.push('');
    out.push('> ⚠ 条数偏少，可能未完整提取（符合性评审表常为跨页表格或合并单元格）；**必须对照招标文件原文核对**。');
  }
} else {
  out.push('（本文件未提取到符合性/资格评审标准，需人工查阅招标文件相应章节）');
}
out.push('');

out.push(`## 四、评分细则（${scores.length} 条）`);
out.push('');
if (scores.length) {
  // 有分值的排前面，按分值降序，让人一眼看到大项在哪
  const withScore = scores.map((r) => ({ ...r, s: scoreOf(r.text) }));
  withScore.sort((a, b) => (b.s ?? -1) - (a.s ?? -1));
  out.push('| 序号 | 页码 | 分值 | 评分内容 |');
  out.push('|---|---|---|---|');
  withScore.forEach((r, i) =>
    out.push(`| ${i + 1} | p${r.page} | ${r.s ?? '-'} | ${r.text.replace(/\|/g, '／').slice(0, 220)} |`),
  );
  if (withScore.length < 10) {
    out.push('');
    out.push('> ⚠ 评分条目仅 ' + withScore.length + ' 条，明显少于常规招标文件（通常 15~40 条），');
    out.push('> 可能是评分表为图片、跨页合并单元格或未使用标准表头导致漏提；**必须先对照招标文件评标办法章节核实**。');
  }
} else {
  out.push('（本文件未提取到评分表，需人工查阅评标办法章节）');
}
out.push('');

// 澄清文件：可能改了评分标准/资格条件，必须单列提醒
if (clar.length) {
  const scoreAffected = clar.filter((c) => (c.affects ?? '').includes('评分标准'));
  out.push(`## 五、澄清文件对规则的修改（${clar.length} 条问答）`);
  out.push('');
  out.push(`> ⚠ 本项目有 **${clar.length}** 条澄清问答，其中 **${scoreAffected.length}** 条涉及评分标准。`);
  out.push('> 上面第四节的评分细则来自**原招标文件**，未合并这些修改——**写标前必须逐条核对**。');
  out.push('');
  const show = scoreAffected.length ? scoreAffected : clar;
  for (const [i, c] of show.slice(0, 25).entries()) {
    // 原文常以「问：」开头，去掉避免和前面的（问）重复
    const q = (c.question ?? '').replace(/^\s*问\s*[：:]\s*/, '');
    const a = (c.answer ?? '').replace(/^\s*答\s*[：:]\s*/, '');
    out.push(`**${i + 1}.** ${q.slice(0, 220)}`);
    if (a) out.push(`   → ${a.slice(0, 220)}`);
    if (c.affects) out.push(`   （涉及：${c.affects}）`);
    out.push('');
  }
  if (show.length > 25) out.push(`> ……还有 ${show.length - 25} 条，见 clarification_qa 表`);
  out.push('');
}

out.push('---');
out.push('');
out.push('> 说明：评分条目按「分值降序」排列，便于识别高分项；');
out.push('> 文字为 PDF 表格提取结果，个别单元格可能因排版错位需对照原文。');

const text = out.join('\n');
if (outArg) {
  const dir = outArg.includes('/') ? outArg.slice(0, outArg.lastIndexOf('/')) : '.';
  mkdirSync(dir, { recursive: true });
  writeFileSync(outArg, text, 'utf8');
  console.log(`已生成：${outArg}`);
} else {
  console.log(text);
}
console.error(`\n[统计] ${doc.title as string} 技术${t} 商务${c} 报价${p} 信用${cr}｜评分 ${scores.length} 条 / 废标 ${rejects.length} 条`);
