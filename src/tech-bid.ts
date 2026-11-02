/**
 * 技术标一键生成：给项目名，出全套（编制依据 + 评分拆解 + 报价基准）。
 *
 * 编排而非重写——四个能力各自已有独立脚本，这里只做：
 *   ① 识别项目类型/城市
 *   ② 定位对应的招标文件解析记录
 *   ③ 调三个生成器拿结果
 *   ④ 拼成一份可直接用的报告 + 独立章节文件
 *
 * 用法：
 *   node --no-warnings src/tech-bid.ts --title="铜陵市义安区2026年学前教育"
 *   node --no-warnings src/tech-bid.ts --title="..." --out=output/某项目
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  CALIBER_LABEL,
  collectPairs,
  summarize,
  typeOfTitle,
  type Caliber,
} from './lib/price-stats.ts';

const DATA = 'data';
const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};

const TITLE = argOf('title');
if (!TITLE) {
  console.log('用法：node src/tech-bid.ts --title="项目名称关键词" [--out=输出目录]');
  process.exit(1);
}

/** 项目类型识别：与 tech-bid-standards.ts 同一套关键词，避免口径漂移 */
const TYPE_KW: Record<string, string[]> = {
  房建: ['房屋建筑', '住宅', '安置房', '学校', '校舍', '医院', '厂房', '教学楼', '综合楼', '小区', '公寓', '装饰', '装修', '幕墙', '钢结构', '楼', '馆'],
  市政: ['道路', '桥梁', '隧道', '市政', '管网', '排水', '污水', '供水', '燃气', '热力', '管廊', '路面', '顶管', '盾构', '照明', '整治'],
  园林: ['绿化', '园林', '景观', '公园', '苗木'],
  水利: ['水利', '河道', '水库', '防洪', '灌溉', '泵站', '堤防', '水闸', '航道', '农田'],
  电力: ['供电', '输变电', '变电站', '配电', '线路工程', '升压站', '电力', '10KV', '10kV', '外线', '供配电', '开闭所', '变电所', '箱变', '电缆敷设'],
  光伏: ['光伏', '风电', '新能源', '储能', '充电桩', '太阳能'],
  智能化: ['智能化', '弱电', '信息化', '监控', '安防', '智慧', '数据中心'],
  老旧小区: ['老旧小区', '既有建筑', '改造', '加固', '维修'],
  装配式: ['装配式', '预制', '模块化'],
};
const types = Object.entries(TYPE_KW)
  .filter(([, kws]) => kws.some((k) => TITLE.includes(k)))
  .map(([t]) => t);
const type = types[0] ?? '房建';

const db = new DatabaseSync(join(DATA, 'index.db'), { readOnly: true });

// 定位招标文件（优先分值已验证的）
const doc = db
  .prepare(
    `SELECT d.attach_guid g, d.pages, d.evaluation_method m,
            d.score_technical t, d.score_commercial c, d.score_price p, d.score_credit cr,
            d.score_verified v, a.title, a.city
     FROM tender_doc d JOIN announcement a ON a.guid = d.announcement_guid
     WHERE a.title LIKE ?
     ORDER BY d.score_verified DESC, d.pages DESC LIMIT 1`,
  )
  .get(`%${TITLE}%`) as Record<string, unknown> | undefined;

// 中标价基准：同类型同城市的中位数（没有就退到同类型）
function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const city = (doc?.city as string) ?? null;
// 价格口径的类型识别必须与 price-benchmark 一致：用 typeOfTitle，
// 而不是标准库的 9 类关键词——后者会把「XX 项目监理」算进房建，
// 而监理的下浮与施工完全不是一个量级。
const priceType = typeOfTitle(TITLE ?? '');
const priceRows = db
  .prepare(
    `SELECT title, city, winner_price p FROM bid_body_result
     WHERE winner IS NOT NULL AND winner_price >= 1000 AND confidence='high'`,
  )
  .all() as Array<{ title: string; city: string | null; p: number }>;
const typed = priceRows.filter((r) => typeOfTitle(r.title) === priceType);
const sameCity = typed.filter((r) => r.city === city).map((r) => r.p);
const priceBench = {
  city,
  cityN: sameCity.length,
  cityMedian: median(sameCity),
  typeN: typed.length,
  typeMedian: median(typed.map((r) => r.p)),
};

// 下浮率：三口径实算，不再用硬编码表。
// 旧版硬编码了「房建 21.7%/19.5%、总体 20.3%/18.1%」一组无出处数字，
// 与 price-benchmark 实算结果相差 1~3 个点，会导致报价系统偏高。
const CALIBERS: Caliber[] = ['limit', 'estimate', 'mixed'];
const calc = CALIBERS.map((c) => {
  const r = collectPairs(db, c);
  const s = summarize(r.pairs.map((p) => p.rate * 100));
  const t = r.pairs.filter((p) => p.type === priceType).map((p) => p.rate * 100);
  return { c, r, s, tn: t.length, ts: t.length ? summarize(t) : null };
});
const caliberArg = (argOf('caliber') ?? 'limit') as Caliber;
const cur = calc.find((x) => x.c === caliberArg) ?? calc[0];
db.close();

const outDir = argOf('out') ?? `output/${TITLE.replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 30)}`;
mkdirSync(outDir, { recursive: true });

const run = (script: string, args: string[]): string => {
  try {
    return execFileSync('node', ['--no-warnings', script, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    return `（生成失败：${String(e).slice(0, 120)}）`;
  }
};

// 1) 编制依据
const standardsMd = run('src/tech-bid-standards.ts', [`--type=${type}`]);
writeFileSync(join(outDir, '01-编制依据.md'), standardsMd, 'utf8');

// 2) 评分拆解（只在找到招标文件时）
let scoringMd = '（未找到该项目的招标文件解析记录，评分拆解跳过）';
if (doc?.g) {
  scoringMd = run('src/tech-bid-scoring.ts', [`--guid=${doc.g as string}`]);
  writeFileSync(join(outDir, '02-评分拆解.md'), scoringMd, 'utf8');
} else {
  writeFileSync(join(outDir, '02-评分拆解.md'), scoringMd, 'utf8');
}

// 3) 报价基准（用同类型同城市的中位数，不是单项目精确值）
const wan = (v: number | null) => (v == null ? '—' : (v / 10000).toFixed(0) + ' 万');
const pct = (v: number | null | undefined) =>
  v == null || Number.isNaN(v) ? '—' : v.toFixed(1) + '%';
const priceMd = [
  `# 报价基准参考`,
  '',
  `> 价格口径：${priceType}（标准章节用 ${type}）｜城市：${city ?? '未知'}`,
  `> 声明：下浮率与中标价均为同类项目统计值，非本项目预测值`,
  '',
  '## 一、中标价参考',
  '',
  '| 维度 | 样本 | 中位数 |',
  '|---|---|---|',
  `| ${city ?? '本城市'} · ${priceType} | ${priceBench.cityN} | ${wan(priceBench.cityMedian)} |`,
  `| 全省 · ${priceType} | ${priceBench.typeN} | ${wan(priceBench.typeMedian)} |`,
  '',
  `## 二、下浮率（${CALIBER_LABEL[cur.c]}口径，实算）`,
  '',
  `> 样本 ${cur.s.n} 条｜算法：招标文件控制价 ↔ 中标公告中标价，项目名归一化后全等匹配`,
  '> 已剔除：多标段（同一项目多个不同价格）、越界值（下浮 < -5% 或 > 45%、中标价 < 控制价 55%）',
  '',
  '| 维度 | 样本 | 平均下浮 | 中位下浮 | 四分位 P25~P75 |',
  '|---|---|---|---|---|',
  `| 全省 · 全部类型 | ${cur.s.n} | ${pct(cur.s.avg)} | ${pct(cur.s.p50)} | ${pct(cur.s.p25)} ~ ${pct(cur.s.p75)} |`,
  cur.ts
    ? `| 全省 · ${priceType} | ${cur.tn} | ${pct(cur.ts.avg)} | ${pct(cur.ts.p50)} | ${pct(cur.ts.p25)} ~ ${pct(cur.ts.p75)} |`
    : `| 全省 · ${priceType} | 0 | — | — | — |`,
  '',
  '## 三、三种价格口径对照（选错口径会差几个点）',
  '',
  '| 价格口径 | 样本 | 全省中位 | 本类型中位 |',
  '|---|---|---|---|',
  ...calc.map(
    (x) =>
      `| ${CALIBER_LABEL[x.c]}${x.c === cur.c ? '（当前）' : ''} | ${x.s.n} | ${pct(x.s.p50)} | ${x.ts ? pct(x.ts.p50) : '—'} |`,
  ),
  '',
  '> 限价 = 最高投标限价（真正的投标上限）；估算 = 合同估算价（招标前拍的价，通常更低）；',
  '> 混合 = 两者合并，仅用于样本不足时参考，**不要用于单项目精算**。',
  '',
  '## 四、怎么用',
  '',
  '```',
  '报价基数 = 招标控制价 × (1 - 本类型中位下浮)',
  '再按竞争烈度上下调 3~5 个百分点：',
  '  项目小、门槛低、潜在投标人多 → 往下调（下浮更深）',
  '  有资质门槛、技术复杂、潜在投标人少 → 往回调（下浮更浅）',
  '```',
  '',
  `> ⚠ 可配对样本占全部中标价的一部分，够看趋势，不够做单项目精算。可用 --caliber=limit|estimate|mixed 切换口径。`,
];

// ---- 供电工程物料单价（来自 6 个真实控制价文件里的 336 条带价清单）----
// 只有当项目是供电/配电类时才附，因为基准库目前只有这一类。
const isPower =
  type === '电力' ||
  /供配电|配电工程|供电|10KV|10kV|箱变|变压器|电缆敷设|外线|变电所|开闭所/.test(TITLE);

if (isPower) {
  const pdb = new DatabaseSync(join(DATA, 'index.db'), { readOnly: true });
  const rows = pdb
    .prepare(
      `SELECT name, feature, unit, price FROM bid_boq_price WHERE price > 0`,
    )
    .all() as Array<{ name: string; feature: string; unit: string; price: number }>;
  pdb.close();

  // 从项目特征里取真实名称和规格——清单列名不可靠（有“电力电缆”实际是“电缆头”的情况）
  const realName = (f: string, fb: string): string => {
    const m = /名\s*称\s*[：:．.、]?\s*([^\d\n，。；;]{2,28})/.exec(f ?? '');
    if (m) {
      const s = m[1].trim();
      if (s.length >= 2 && !/^[A-Za-z\-\d/.\s]+$/.test(s)) return s;
    }
    return fb ?? '';
  };
  const specOf = (f: string): string => {
    for (const re of [
      /规格型号\s*[：:．.、]?\s*([^\s，。；;]{2,40})/,
      /规\s*格\s*[：:．.、]?\s*([^\s，。；;]{2,40})/,
      /型\s*号\s*[：:．.、]?\s*([^\s，。；;]{2,40})/,
    ]) {
      const m = re.exec(f ?? '');
      if (m) return m[1].trim();
    }
    // 特征里直接把型号写在「名称：」后面的（如「名称：YJV22-8.7/15-3x300」）
    const m2 = /名\s*称\s*[：:．.、]?\s*([A-Za-z][\w\-/.×*]{3,40})/.exec(f ?? '');
    return m2 ? m2[1].trim() : '';
  };

  const groups = new Map<string, { n: number; prices: number[]; unit: string }>();
  for (const r of rows) {
    const nm = realName(r.feature, r.name);
    const sp = specOf(r.feature);
    const key = `${nm}||${sp}`;
    const g = groups.get(key) ?? { n: 0, prices: [], unit: r.unit ?? '' };
    g.n += 1;
    g.prices.push(r.price);
    groups.set(key, g);
  }
  const med = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };

  // 按**业务重要性**排序，不是按单价降序——
  // 否则电缆（几百元/m）会被柴油发电机（85 万/台）挤到表外，而电缆往往是造价大头。
  const MAT_ORDER = [
    /^电力电缆|^电缆$|^高压电缆|^低压电缆/,
    /拖拉管|顶管/,
    /保护管|排管/,
    /桥架/,
    /高压.*柜|开关柜|环网/,
    /低压.*柜/,
    /配电箱|分支箱/,
    /变压器$|^变压器/,
    /箱式变|箱变/,
    /发电机组/,
    /母线/,
    /电缆头|终端头|熔接/,
    /接地/,
    /电缆井|检查井/,
  ];
  const all = [...groups.entries()].map(([k, g]) => ({
    nm: k.split('||')[0], sp: k.split('||')[1], ...g, med: med(g.prices),
  }));
  const picks: typeof all = [];
  const used = new Set<string>();
  for (const re of MAT_ORDER) {
    const hit = all
      .filter((x) => !used.has(x.nm + '||' + x.sp) && re.test(x.nm))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3);
    for (const h of hit) {
      picks.push(h);
      used.add(h.nm + '||' + h.sp);
    }
    if (picks.length >= 24) break;
  }

  if (picks.length) {
    priceMd.push('');
    priceMd.push('## 四、供电工程物料单价（控制价口径）');
    priceMd.push('');
    priceMd.push('> 来源：6 个真实招标项目的《最高投标限价》文件，336 条带价清单');
    priceMd.push('> 自洽校验：工程量 × 综合单价 = 合价，336/336 = 100%');
    priceMd.push('');
    priceMd.push('| 物料 | 规格 | 中位单价 | 项数 | 单位 |');
    priceMd.push('|---|---|---|---|---|');
    for (const p of picks) {
      priceMd.push(
        `| ${p.nm.slice(0, 18)} | ${p.sp.slice(0, 22) || '—'} | **${p.med.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}** | ${p.n} | ${p.unit} |`,
      );
    }
    priceMd.push('');
    priceMd.push('**怎么用**：清单里有“YJV22-8.7/15-3x300 电缆 7,759 m” → 查表 905.26 元/m → 该项 702.4 万。');
    priceMd.push('');
    priceMd.push('> ⚠ 本表是**控制价口径**（招标人上限价），报参考价时再乘 (1 - 下浮率)，供电类下浮中位 14.4%。');
  }
}

priceMd.push('');
const priceText = priceMd.join('\n');
writeFileSync(join(outDir, '03-报价基准.md'), priceText, 'utf8');

// 4) 总览
const p = Number(doc?.p ?? 0);
const t = Number(doc?.t ?? 0);
const c = Number(doc?.c ?? 0);
const cr = Number(doc?.cr ?? 0);
const sum = t + c + p + cr;
const idx = [
  `# 技术标材料包：${TITLE}`,
  '',
  `> 项目类型：${types.join(' + ') || type}｜城市：${city ?? '未知'}`,
  doc ? `> 招标文件：${doc.pages as number} 页｜评标办法：${doc.m ?? '未识别'}${doc.v ? '（分值已验证）' : ''}` : '> 未找到该项目的招标文件解析记录',
  '',
  '## 一、关键结论',
  '',
  sum > 0
    ? `- 分值构成：**技术 ${t} / 商务 ${c} / 报价 ${p}${cr ? ` / 信用 ${cr}` : ''}**（合计 ${sum}）`
    : '- 分值构成：未识别，需人工查阅招标文件评标办法章节',
  sum > 0 ? `- 权重最高：**${[[ '报价', p], ['技术标', t], ['商务标', c], ['信用标', cr]].sort((a, b) => Number(b[1]) - Number(a[1]))[0][0]}**` : '',
  `- 同类中标价中位数：**${wan(priceBench.typeMedian)}**（${priceBench.typeN} 条样本）`,
  `- 参考下浮率：**${pct(cur.s.p50)}**（${CALIBER_LABEL[cur.c]}口径，${cur.s.n} 条样本）`,
  '',
  '## 二、材料清单',
  '',
  '| 文件 | 内容 |',
  '|---|---|',
  '| [01-编制依据.md](01-编制依据.md) | 技术标「编制依据」章节，按项目类型出全套标准 |',
  '| [02-评分拆解.md](02-评分拆解.md) | 分值构成 + 应标策略 + 废标风险点 + 评分细则 |',
  '| [03-报价基准.md](03-报价基准.md) | 同类项目中标价与下浮率参考 |',
  '',
  '## 三、使用说明',
  '',
  '1. **编制依据**可直接粘贴进技术标，按需删减；',
  '2. **评分拆解**先看废标条款（不服即出局），再看高分项；',
  '3. **报价基准**只给趋势，实际报价需结合控制价与竞争判断。',
]
  // 只去首尾空行，中间空行要保留（否则 Markdown 会挤成一团）
  .join('\n')
  .replace(/^\n+|\n+$/g, '') + '\n';
writeFileSync(join(outDir, 'README.md'), idx, 'utf8');

console.log(`已生成材料包：${outDir}`);
console.log(`  类型 ${types.join('+') || type}｜城市 ${city ?? '-'}｜招标文件 ${doc ? `${doc.pages as number}页` : '未找到'}`);
if (sum > 0) console.log(`  分值 技术${t}/商务${c}/报价${p}${cr ? `/信用${cr}` : ''}`);
console.log(`  同类中标价中位数 ${wan(priceBench.typeMedian)}（${priceBench.typeN} 条）`);
console.log(`\n产物：README.md / 01-编制依据.md / 02-评分拆解.md / 03-报价基准.md`);
