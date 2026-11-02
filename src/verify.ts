/**
 * 召回验证：用站内搜索取指定业务词的真实公告，再跑分类，检验规则能不能认出来。
 *
 * 用法：
 *   node src/verify.ts                                  # 默认词表
 *   node src/verify.ts --probes=变电站,配电工程 --pages=10
 *   node src/verify.ts --probes=升压站 --pages=15 --max=12 --out=data/power-recall.md
 *
 * 术语说明：
 * - 「标题命中」= 公告标题包含该搜索词，这批样本基本可以确定为真值；
 * - 「仅正文命中」= 搜索命中但标题不含，可能是配套描述，结论要打折。
 *   报告把两者分开，避免用低纯度样本得出虚假的召回率。
 */

import { writeFileSync, mkdirSync } from 'node:fs';

import { TAG_LABELS, type Tag } from './config.ts';
import { classify, compactEvidence, formatEvidence, projectScope } from './classify.ts';
import { fetchDetail, type ListItem } from './source/provincial.ts';
import { searchAnnouncements, type SearchHit } from './source/search.ts';

interface Args {
  probes: string[];
  pages: number;
  max: number;
  year: string;
  out: string;
  samplesOut: string;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, d: string) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };

  return {
    probes: get('probes', '输变电,变电站,配电工程,电力工程,架空线路,升压站,开闭所,发电工程')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    pages: Number(get('pages', '10')),
    max: Number(get('max', '10')),
    year: get('year', '2026'),
    out: get('out', 'data/recall-report.md'),
    samplesOut: get('samples', 'data/verify-samples.json'),
  };
}

/** 搜索词 → 期望类别。按显式词表判断，避免"教学楼"这类词落回默认的 power。 */
function expectTagOf(param: string): Tag {
  if (/光伏|组件|逆变器|硅片/.test(param)) return 'pv';
  if (/储能|蓄能|配储/.test(param)) return 'storage';
  if (/建筑|面积|装修|幕墙|用房|厂房|楼|房|小区|改造|公寓|宿舍|仓库/.test(param)) {
    return 'building';
  }
  return 'power';
}

const args = parseArgs(process.argv.slice(2));

interface Sample {
  param: string;
  title: string;
  date: string;
  titleHit: boolean;
  tags: Tag[];
  primary: Tag | null;
  scores: Record<Tag, number>;
  evidence: string;
  scope: string;
  hit: boolean;
  /**
   * 被更具体的类别捕获。例如搜"发电工程"找到的光伏发电项目被判为光伏，
   * 比笼统的电力更有用，不应算漏检。
   */
  moreSpecific: boolean;
}

const samples: Sample[] = [];

for (const param of args.probes) {
  const expect = expectTagOf(param);
  console.log(`\n=== 「${param}」 → 期望 ${TAG_LABELS[expect]} ===`);

  const hits: SearchHit[] = [];
  for (let page = 1; page <= args.pages; page++) {
    hits.push(...(await searchAnnouncements(param, page)));
  }

  const candidates = hits.filter(
    (h) => h.date.startsWith(args.year) && h.href.includes('/jsgc/') && h.section.includes('交易信息'),
  );

  // 标题含搜索词的优先检查：它们才是高纯度真值样本
  candidates.sort((a, b) => Number(b.title.includes(param)) - Number(a.title.includes(param)));

  const toCheck = candidates.slice(0, args.max);
  console.log(`扫描 ${hits.length}，${args.year} 年建设工程 ${candidates.length}，检查 ${toCheck.length}`);

  for (const h of toCheck) {
    const item: ListItem = {
      guid: h.guid,
      tenderProjectType: h.projectTypeParam || '1',
      bulletinNature: h.natureParam || '1',
      area: '',
      city: '',
      district: '',
      title: h.title,
      pubDate: h.date,
      projectType: '',
      natureLabel: '',
    };

    let tags: Tag[] = [];
    let primary: Tag | null = null;
    let evidence = '';
    let scope = '';
    let scores: Record<Tag, number> = { pv: 0, storage: 0, power: 0, building: 0 };

    try {
      const detail = await fetchDetail(item);
      const cls = classify(h.title, detail.text);
      tags = cls.tags;
      primary = cls.primaryTag;
      scores = cls.scores;
      evidence = formatEvidence(cls);
      const deduped = detail.text.split(h.title).join(' ');
      scope = projectScope(deduped).replace(/\s+/g, ' ');
    } catch (err) {
      evidence = `[抓取失败: ${String(err).slice(0, 80)}]`;
    }

    samples.push({
      param,
      title: h.title,
      date: h.date,
      titleHit: h.title.includes(param),
      tags,
      primary,
      scores,
      evidence,
      scope,
      hit: tags.includes(expect),
      moreSpecific: expect === 'power' && (tags.includes('pv') || tags.includes('storage')),
    });
  }
}

// ---- 报告 ----
const lines: string[] = [];
const push = (s = '') => lines.push(s);
mkdirSync('data', { recursive: true });

push('# 分类召回验证报告');
push();
push(`生成时间：${new Date().toLocaleString('zh-CN')}　目标年份：${args.year}`);
push();

push('## 汇总');
push();
push('| 搜索词 | 期望 | 扫描样本 | 标题命中 | 标题命中→识别 | 仅正文命中 | 仅正文→识别 |');
push('|---|---|---|---|---|---|---|');

for (const param of args.probes) {
  const expect = expectTagOf(param);
  const rows = samples.filter((s) => s.param === param);
  const titled = rows.filter((s) => s.titleHit);
  const bodyOnly = rows.filter((s) => !s.titleHit);
  const ok = (r: Sample) => r.hit || r.moreSpecific;
  const titledHit = titled.filter(ok).length;
  const bodyHit = bodyOnly.filter(ok).length;

  push(
    `| ${param} | ${TAG_LABELS[expect]} | ${rows.length} | ${titled.length} | ` +
      `${titledHit}/${titled.length} | ${bodyOnly.length} | ${bodyHit}/${bodyOnly.length} |`,
  );
}
push();
push('> 识别 = 判为期望类别，或被更具体的类别（光伏/储能）捕获。');
push();

// 按期望类别分组统计。标题含搜索词的样本才是高纯度真值，
// 仅正文命中的样本可能只是配套描述，单独列出以免虚高召回率。
for (const tag of ['pv', 'storage', 'power', 'building'] as Tag[]) {
  const group = samples.filter((s) => expectTagOf(s.param) === tag);
  if (group.length === 0) continue;

  const titled = group.filter((s) => s.titleHit);
  const titledOk = titled.filter((s) => s.hit || s.moreSpecific);
  const bodyOnly = group.filter((s) => !s.titleHit);
  const bodyOk = bodyOnly.filter((s) => s.hit || s.moreSpecific);

  push(`## ${TAG_LABELS[tag]}类总体`);
  push();
  push(`- 检查样本：${group.length} 条（其中标题含词 ${titled.length} 条）`);
  push(
    `- 标题含词（高纯度真值）识别：${titledOk.length}/${titled.length}` +
      `，召回率 ${titled.length ? ((titledOk.length / titled.length) * 100).toFixed(0) : '-'}%`,
  );
  push(`- 仅正文命中识别：${bodyOk.length}/${bodyOnly.length}（样本纯度低，仅供参考）`);
  push();
}

// 逐条明细，便于人工复核
for (const param of args.probes) {
  const rows = samples.filter((s) => s.param === param);
  if (rows.length === 0) continue;

  push(`## 「${param}」明细`);
  push();
  for (const s of rows) {
    const mark = s.hit ? '✅' : s.moreSpecific ? '➡️' : '❌';
    const tagText = s.tags.length ? s.tags.map((t) => TAG_LABELS[t]).join('/') : '(未归类)';
    push(`${mark} **${s.title}**`);
    push(
      `- ${s.date}｜标题含词：${s.titleHit ? '是' : '否'}｜主类：` +
        `${s.primary ? TAG_LABELS[s.primary] : '(无)'}｜全部：${tagText}`,
    );
    push(`- 得分：${(Object.entries(s.scores) as Array<[Tag, number]>)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${TAG_LABELS[k]}${v}`)
      .join(' ') || '(全 0)'}`);
    push(`- 证据：${s.evidence || '(无)'}`);
    push(`- 分类文本：${s.scope.slice(0, 160)}…`);
  }
  push();
}

writeFileSync(args.out, lines.join('\n'), 'utf8');
writeFileSync(args.samplesOut, JSON.stringify(samples, null, 2), 'utf8');

const okCount = samples.filter((s) => s.hit).length;
console.log(`\n共检查 ${samples.length} 条，命中 ${okCount} 条`);
console.log(`报告：${args.out}`);
console.log(`样本：${args.samplesOut}`);
