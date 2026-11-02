/**
 * 统计高频评分点——从 76,732 行 scoring_item 里提炼"安徽招投标最常考什么"。
 *
 * 评分表的典型结构（实测）：
 *   ['2.2.2（2）', '商务文件评分标准', '投标人资信认证', '6 分', '投标人具有经...']
 *                                      ↑评分因素        ↑分值    ↑评分标准
 * 其中评分因素在"数字+分"单元格的前一列；也有内嵌写法「设计构思（12 分）」。
 *
 * 归一化是关键：不做同义词合并，会得到几百个各出现一两次的碎片，
 * 看不出规律。合并后才能回答"哪些评分点几乎所有项目都考"。
 *
 * 用法：node --no-warnings src/scoring-hotspots.ts [--top=40] [--out=path.md]
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const DATA = 'data';
const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const TOP = Number(argOf('top') ?? 40);
const OUT = argOf('out');

const db = new DatabaseSync(join(DATA, 'index.db'), { readOnly: true });

const SCORE =
  "cells_json LIKE '%分值%' OR cells_json LIKE '%得分%' OR cells_json LIKE '%评分标准%' OR cells_json LIKE '%评分因素%'";

const rows = db
  .prepare(`SELECT attach_guid g, cells_json FROM scoring_item WHERE ${SCORE}`)
  .all() as Array<{ g: string; cells_json: string }>;
db.close();

/** 纯分值单元格：「6 分」「12分」「1.0 分」 */
const PURE_SCORE = /^\s*(\d+(?:\.\d+)?)\s*分\s*$/;
/** 内嵌分值：「设计构思（12 分）」「业绩（≤6 分）」 */
const INLINE_SCORE = /([^（）()|]{2,24}?)\s*[（(]\s*[≤<]?\s*(\d+(?:\.\d+)?)\s*分[^）)]*[）)]/g;
/** 文字型分值：「得 3 分」「加 1.5 分」「满分 6 分」——用于没有独立分值列的评分表 */
const TEXT_SCORE = /(?:得分|加|满分|计)\s*(\d+(?:\.\d+)?)\s*分/g;

/** 明显不是评分因素的噪声（表头、章节名、汇总项） */
const NOISE = [
  '条款号', '评审标准', '评分标准', '评分因素', '分值', '满分分值', '评审内容', '指标描述',
  '分值构成', '分值组成', '评标方法', '中标候选人排序', '得分计算', '备注', '说明', '序号',
  // 表头类（实测会作为“评分点”混进来）
  '技术部分评分标准', '商务部分评分标准', '报价文件评分标准', '技术文件评分标准',
  '评标价', '总得分', '综合得分', '合计', '小计', '本项', '本小项', '以上',
];

const clean = (s: string): string =>
  s
    .replace(/\s+/g, '')
    .replace(/^[0-9.．、]+/, '') // 去掉前导编号
    .replace(/[（(][^）)]*[）)]/g, '') // 去掉括号说明
    .trim();

/**
 * 归一化：把「投标人类似项目业绩」「企业类似业绩」「类似工程业绩」收敛成「类似业绩」。
 *
 * 顺序敏感，且当前顺序是"先宽泛后具体"——这是刻意选择：
 * 「项目负责人业绩」在业务上属于业绩的一种，归入「类似业绩」比归入「项目负责人」更合理。
 * 改顺序会改变高频榜数值，非必要不要动。
 */
const RULES: Array<[RegExp, string]> = [
  [/业绩/, '类似业绩'],
  [/奖项|获奖|荣誉/, '获奖情况'],
  [/认证|资信|信用|诚信|不良行为/, '资信与信用'],
  [/项目负责人|项目经理|总负责人|设计负责人|施工负责人|总监/, '项目负责人'],
  [/人员数量|人员配置|人员资格|人员职称|人员结构|拟派人员|项目组人员/, '人员配置'],
  [/重难点|重点难点|难点/, '重难点分析'],
  [/设计方案|设计构思|设计管理|设计说明|初步设计|施工图/, '设计方案'],
  [/施工组织|施工方案|施工部署|施工计划|进度计划|工期/, '施工组织与进度'],
  [/质量|质量控制|质量保证/, '质量保证措施'],
  [/安全|安全生产|安全文明|文明施工|环保|环境/, '安全文明施工'],
  [/服务|售后|响应|承诺/, '服务承诺'],
  [/设备|机具|仪器|检测设备/, '设备配置'],
  [/报价|投标报价|价格|费率/, '投标报价'],
  [/技术方案|技术标|技术文件/, '技术方案'],
  [/管理方案|管理组织|组织方案|实施方案/, '管理方案'],
  [/标准化|工地|现场/, '标准化工地'],
  [/BIM|信息化|智慧/, 'BIM与信息化'],
  [/绿色|节能|装配式/, '绿色与节能'],
];

function normalize(raw: string): string | null {
  let s = clean(raw);
  if (!s || s.length < 2 || s.length > 24) return null;
  if (NOISE.some((n) => s === n || s.startsWith(n))) return null;
  // 纯数字/纯符号
  if (/^[\d.．、\-—~～]+$/.test(s)) return null;
  // 段落型提取会抓到举例文字（“举例：…A公司 81 分”），必须过滤掉。
  // 实测噪声：C公司 / B公司 / 同时入围。举例：投标人合计评审得分为：A公司 / ；第2名：B公司
  if (/^[A-Za-z]公司$/.test(s)) return null;
  if (/(举例|入围|排名|得分为|名：|第\d+名|示例)/.test(s)) return null;
  if (/公司$/.test(s) && s.length <= 6) return null;
  for (const [re, label] of RULES) if (re.test(s)) return s.replace(/.*/, label);
  return s; // 未命中的保留原样
}

interface Stat {
  count: number;
  totalScore: number;
  docs: Set<string>;
  samples: Set<string>;
}
const stats = new Map<string, Stat>();
let extracted = 0;
let normalized = 0;

const bump = (label: string, raw: string, score: number, doc: string): void => {
  const st = stats.get(label) ?? { count: 0, totalScore: 0, docs: new Set(), samples: new Set() };
  st.count++;
  st.totalScore += score;
  st.docs.add(doc);
  if (st.samples.size < 3) st.samples.add(clean(raw).slice(0, 16));
  stats.set(label, st);
};

for (const r of rows) {
  let cells: string[];
  try {
    cells = (JSON.parse(r.cells_json) as unknown[]).map((x) => String(x ?? ''));
  } catch {
    continue;
  }

  // 合并单元格的评分因素常只写在首行，后续行留空——用 carry 向下继承
  let carry = '';
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const m = PURE_SCORE.exec(cell);
    if (m) {
      // 评分因素 = 往左最近的非空单元格；若本行没有，用上一行继承的
      let src = '';
      for (let j = i - 1; j >= 0; j--) {
        const cand = cells[j];
        if (!cand.trim()) continue;
        if (PURE_SCORE.test(cand)) break;
        src = cand;
        break;
      }
      if (!src.trim()) src = carry;
      else carry = src; // 记住这一行显式写的评分因素，供后续空行继承
      if (!src.trim()) continue;
      extracted++;
      const label = normalize(src);
      if (label) {
        normalized++;
        bump(label, src, Number(m[1]), r.g);
      }
    }
  }

  // 内嵌写法：「设计构思（12 分）」
  const flat = cells.join(' | ');
  for (const m of flat.matchAll(INLINE_SCORE)) {
    extracted++;
    const label = normalize(m[1]);
    if (label) {
      normalized++;
      bump(label, m[1], Number(m[2]), r.g);
    }
  }

  // 文字型：「得 3 分」——只在没有独立分值列时兜底，避免与上面的重复计数。
  // 已知局限：取不到分值归属的评分因素，只用于“有没有考这个点”的统计。
  if (!cells.some((c) => PURE_SCORE.test(c))) {
    const hits = [...flat.matchAll(TEXT_SCORE)];
    for (const m of hits) {
      // 取分值前最近的文字片段作为疑似评分因素
      const before = flat.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0);
      const seg = before.split(/[|。；;、,，]/).filter((s) => s.trim()).pop() ?? '';
      const label = normalize(seg);
      if (!label) continue;
      extracted++;
      normalized++;
      bump(label, seg, Number(m[1]), r.g);
    }
  }
}

const docTotal = new Set(rows.map((r) => r.g)).size;
const list = [...stats.entries()]
  .map(([label, s]) => ({ label, ...s, docRatio: (s.docs.size / docTotal) * 100, avg: s.totalScore / s.count }))
  .sort((a, b) => b.docs.size - a.docs.size || b.count - a.count);

const out: string[] = [];
out.push('# 安徽招投标高频评分点统计');
out.push('');
out.push(`> 数据来源：${docTotal} 份招标文件的评标办法评分表`);
out.push(`> 提取评分因素 ${extracted} 处，归一化后有效 ${normalized} 处，归并为 ${list.length} 类`);
out.push(`> 统计口径：「出现文件数」= 有多少份招标文件考过这一项，比出现次数更能反映普遍性`);
out.push('>');
out.push('> ⚠ **占比是下界不是准确值**：PDF 评分表排版差异极大（合并单元格、跨页续行、分值写在文字里），');
out.push('> 单份文件平均只能提取到 2~4 处评分因素，远少于实际的 15~40 处。所以「21.5%」不代表只有 21.5% 的项目考报价，');
out.push('> 而是**至少** 21.5%。**相对排序可信，绝对占比偏低**。');
out.push('');

out.push('## 一、Top 评分点（按出现文件数排序）');
out.push('');
out.push('| 排名 | 评分点 | 出现文件数 | 占样本 | 出现次数 | 平均分值 |');
out.push('|---|---|---|---|---|---|');
list.slice(0, TOP).forEach((x, i) => {
  out.push(`| ${i + 1} | ${x.label} | ${x.docs.size} | ${x.docRatio.toFixed(1)}% | ${x.count} | ${x.avg.toFixed(1)} |`);
});
out.push('');

// 第一梯队：按相对排序取前 7 个——绝对占比不可靠，但前 7 名在所有项目里都是主力
const firstTier = list.slice(0, 7);
out.push('## 二、第一梯队（按相对排序的前 7 项）');
out.push('');
for (const x of firstTier) {
  out.push(`- **${x.label}** —— ${x.docs.size} 份文件考过，平均 ${x.avg.toFixed(1)} 分（样例：${[...x.samples].slice(0, 2).join('、')}）`);
}
out.push('');
out.push('这 7 项构成技术标的主体内容——写标时优先保证这几块不失分，再去拼长尾。');
out.push('');

// 分值最高（排除明显是汇总项的高分噪声）
const highValue = [...list]
  .filter((x) => x.avg < 90 && x.docs.size >= 5)
  .sort((a, b) => b.avg - a.avg)
  .slice(0, 10);
out.push('## 三、单项分值最高的评分点（平均分）');
out.push('');
out.push('| 评分点 | 平均分值 | 出现文件数 |');
out.push('|---|---|---|');
for (const x of highValue) out.push(`| ${x.label} | ${x.avg.toFixed(1)} | ${x.docs.size} |`);
out.push('');
out.push('---');
out.push('');
out.push('> 说明：分值为该评分点在各文件中标注的满分值平均，同一评分点在不同项目权重差异较大，仅供参考。');

const text = out.join('\n');
if (OUT) {
  const dir = OUT.includes('/') ? OUT.slice(0, OUT.lastIndexOf('/')) : '.';
  mkdirSync(dir, { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  console.log(`已生成：${OUT}`);
} else {
  console.log(text);
}
console.error(`\n[统计] 文件 ${docTotal} 份｜提取 ${extracted} 处｜有效 ${normalized} 处｜归并 ${list.length} 类`);
