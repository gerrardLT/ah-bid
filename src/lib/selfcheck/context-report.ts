/**
 * 项目本体信号的报告渲染。
 *
 * 独立于 report.ts：那边是「规则诊断」的展示，这里是「工程本体」的展示。
 * 分开的好处是 report.ts 的表格结构与排序完全不受影响（零回归）。
 *
 * 展示顺序按"越可执行越靠前"：
 *   关注点（项目在问什么）→ 清单方案（这个项目有哪些活）→ 态势（紧不紧）→ 规范（引对没）
 *
 * 每节都带分母（n）、来源与降级原因；没有分母的百分比一律不出现。
 */

import type { ProjectContext } from '../project-context.ts';

function esc(s: string): string {
  return String(s ?? '').replace(/\|/g, '／').replace(/\n/g, ' ');
}

function clip(s: string, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function wan(yuan: number | null): string {
  if (yuan === null) return '—';
  return `${(yuan / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 万`;
}

const VERDICT_MARK: Record<string, string> = {
  现行: '✅ 现行',
  有更新版: '⚠ 有更新版',
  已废止: '❌ 已废止',
  库内未收录: '· 库内未收录（不作判定）',
};

export function renderContextSection(ctx: ProjectContext): string {
  const out: string[] = [];
  out.push('');
  out.push('---');
  out.push('');
  out.push('# 工程本体信号');
  out.push('');
  out.push('> 这一部分来自**招标文件与澄清答疑**，不是标书本身。');
  out.push('> 它回答的是「这个项目要特别注意什么」，与上文的「标书写得全不全」互为补充。');
  out.push('');

  // ---------------- 一、澄清关注点 ----------------
  out.push('## 一、本项目关注点（来自澄清答疑）');
  out.push('');
  if (ctx.qa.n === 0) {
    out.push('（本项目没有澄清数据，无法归纳关注点）');
  } else {
    out.push(
      `> 本项目 ${ctx.qa.n} 条澄清，命中 ${ctx.qa.items.length} 个主题｜` +
        `置信度：${ctx.qa.confidence === 'project' ? '**本项目数据**' : '**仅全库先验**（本项目条数过少）'}`,
    );
    out.push('');
    out.push('| 主题 | 本项目条数 | 占比 | 涉评分 | 典型问题（原文） |');
    out.push('|---|---|---|---|---|');
    for (const it of ctx.qa.items.slice(0, 12)) {
      out.push(
        `| ${esc(it.name)} | ${it.count} | ${(it.share * 100).toFixed(0)}% | ${it.scoring} | ` +
          `${esc(clip(it.examples[0] ?? '', 60))} |`,
      );
    }
    out.push('');
    if (ctx.qa.unclassified.length) {
      out.push('**本项目专属问题（未归类，需人工看）** —— 这些恰恰是最有项目特异性的：');
      out.push('');
      ctx.qa.unclassified.forEach((q, i) => out.push(`${i + 1}. ${esc(clip(q, 100))}`));
      out.push('');
    }
  }

  // ---------------- 二、清单要求的施工方案 ----------------
  out.push('## 二、本项目清单要求的施工方案');
  out.push('');
  const boq = ctx.boq;
  if (!boq) {
    out.push('（本项目没有 zip 附件，无法从清单推导施工方案）');
    out.push('');
  } else if (boq.schemes.length === 0) {
    out.push(`（${esc(boq.note ?? '附件里没有可解析的工程量清单')}）`);
    out.push('');
  } else {
    out.push(
      `> 从招标附件里的工程量清单推导（编码前 4 位 = 专业 + 章）：` +
        `${boq.parsedZips} 个 zip 解析出 ${boq.rows.toLocaleString('zh-CN')} 项清单，` +
        `映射到 ${boq.schemes.length} 类施工方案` +
        (boq.unmapped ? `（${boq.unmapped} 项编码未在映射表内）` : ''),
    );
    out.push(
      '> ⚠ 只判断「**有没有这类活**」；工程量为原始累加未校核，不在此展示；' +
        '地方补充编码（非国标 12 位）可能误落入相邻章节。',
    );
    out.push('');
    out.push('| 专业 | 施工方案 | 清单项数 | 主要分项 |');
    out.push('|---|---|---|---|');
    for (const s of boq.schemes) {
      out.push(`| ${esc(s.profession)} | ${esc(s.scheme)} | ${s.count} | ${esc(s.top.join('、') || '—')} |`);
    }
    out.push('');

    // 闭环：清单说要写这些方案，标书里写了没有
    if (boq.coverage?.length) {
      const miss = boq.coverage.filter((c) => !c.covered);
      out.push(`### 覆盖检查：清单要求的方案，标书写了没有`);
      out.push('');
      out.push(
        `> ${boq.coverage.length} 类方案中，**已覆盖 ${boq.coverage.length - miss.length} 类，缺 ${miss.length} 类**。` +
          `判定口径与规则诊断一致：命中行必须有实质内容，只有小标题不算。`,
      );
      out.push('');
      out.push('| 施工方案 | 标书状态 | 证据 |');
      out.push('|---|---|---|');
      const ordered2 = [...boq.coverage].sort(
        (a, b) => Number(a.covered) - Number(b.covered) || a.scheme.localeCompare(b.scheme),
      );
      for (const c of ordered2) {
        out.push(
          `| ${esc(c.scheme)} | ${c.covered ? '✅ 已覆盖' : '**❌ 缺失**'} | ` +
            (c.covered ? `L${(c.line ?? 0) + 1} ${esc(clip(c.snippet ?? '', 40))}` : '—') +
            ' |',
        );
      }
      out.push('');
    }

    out.push(
      '> 清单里有这些分项，技术标就必须有对应的施工方案——' +
        '这是评委判断「针对性」最直接的地方（他们知道这个工程有什么活）。',
    );
    out.push('');
  }

  // ---------------- 三、工期/限价态势 ----------------
  out.push('## 三、工期与限价态势');
  out.push('');
  const s = ctx.schedule;
  const lim = ctx.limit;
  out.push('| 指标 | 本项目 | 基线 n | 中位 | P25–P75 | 位置 |');
  out.push('|---|---|---|---|---|---|');
  if (s.days === null) {
    out.push(`| 工期 | — | — | — | — | ${esc(s.level)} |`);
  } else {
    const b = s.baseline;
    out.push(
      `| 工期 | ${s.days} 天 | ${b ? b.n : '—'} | ${b ? `${b.p50} 天` : '—'} | ` +
        `${b ? `${b.p25}–${b.p75} 天` : '—'} | **${esc(s.level)}**${s.baselineName ? `（基准：${esc(s.baselineName)}）` : ''} |`,
    );
  }
  if (lim.amount === null) {
    out.push('| 限价 | — | — | — | — | 未抽取到 |');
  } else {
    const lb = lim.baseline;
    out.push(
      `| 限价 | ${wan(lim.amount)} | ${lb ? lb.n : '—'} | ${lb ? wan(lb.p50) : '—'} | ` +
        `${lb ? `${wan(lb.p25)}–${wan(lb.p75)}` : '—'} | 档位：${esc(lim.tier ?? '—')} |`,
    );
  }
  out.push('');
  out.push(
    '> 位置 = 本项目工期落在同类分布的哪一段。**只在样本 n≥30 时给结论**；' +
      '「偏紧/偏宽」是统计位置，不是对工期合理性的判断。',
  );
  out.push('');

  // ---------------- 四、规范符合性 ----------------
  out.push('## 四、规范符合性（编制依据章节）');
  out.push('');
  const st = ctx.standards;
  if (st.cited === 0) {
    out.push(
      st.located
        ? '（「编制依据」章节存在，但未识别到标准号）'
        : '（未找到「编制依据」章节，已全文检索，仍未识别到标准号）',
    );
    out.push('');
  } else {
    const count = (v: string): number => st.findings.filter((f) => f.verdict === v).length;
    out.push(
      `> ${st.located ? '「编制依据」章节内' : '全文'}识别到 ${st.cited} 条标准：` +
        `现行 ${count('现行')}｜有更新版 ${count('有更新版')}｜已废止 ${count('已废止')}｜` +
        `库内未收录 ${count('库内未收录')}`,
    );
    out.push('');
    out.push('| 引用原文 | 判定 | 库内版本 | 行号 | 说明 |');
    out.push('|---|---|---|---|---|');
    for (const f of st.findings.slice(0, 40)) {
      out.push(
        `| ${esc(f.raw)} | ${VERDICT_MARK[f.verdict] ?? esc(f.verdict)} | ${esc(f.libCode ?? '—')} | ` +
          `L${f.line + 1} | ${esc(clip(f.note ?? '', 60))} |`,
      );
    }
    if (st.findings.length > 40) out.push(`| … | | | | 还有 ${st.findings.length - 40} 条 |`);
    out.push('');

    if (st.missingCore.length) {
      out.push(`**漏引（高置信，本项目类型常规必引）**：${st.missingCore.map(esc).join('、')}`);
      out.push('');
    }
    if (st.missingMandatory.length) {
      out.push(
        `**建议核对（全文强制规范，共 ${st.missingMandatory.length} 条未见引用）**：` +
          `${st.missingMandatory.map(esc).join('、')}`,
      );
      out.push('');
    }
    if (!st.typeKnown) {
      out.push('> 未指定项目类型，本次不判强制规范漏引。用 `--project-type=房建` 可开启。');
      out.push('');
    }
  }
  out.push(
    '> 「库内未收录」只表示本地标准库没有这条，**不代表标准错误或废止**——' +
      '库只有 505 条国标行标 + 5,651 条安徽地标，标书引用面远大于库存。',
  );
  out.push('');

  // ---------------- 降级说明 ----------------
  if (ctx.notes.length) {
    out.push('### 本次的降级与说明');
    out.push('');
    for (const n of ctx.notes) out.push(`- ${esc(n)}`);
    out.push('');
  }

  return out.join('\n');
}
