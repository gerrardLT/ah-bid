/**
 * 业绩门槛五要素抽取（纯函数，零数据库依赖）。
 *
 * 为什么不再用一句话正则：原来的 RE_PERF 是「近X年 … X个 … 类似 … 业绩」四锚点 AND 链，
 * 第一锚点「近X年」在全库只覆盖 9.0%，于是 8,494 条只抽到 41 条。
 * 而实测各要素单独出现率：数量词 71.9%、业绩二字 77.2%、金额 17.2%、
 * 类似/同类 13.3% —— 拆开抽，每个要素都能拿到。
 *
 * 三个实测结论决定了这张表的设计：
 *   1. **50.0%（4,249 条）明确写"业绩要求：/"或"不要求"** —— 这是有效信息，不是"没抽到"。
 *   2. 176 条只写"详见招标文件" —— 也必须是独立状态。
 *   3. 只有 27.0%（2,297 条）有实质门槛。
 *
 * 纪律（与 deadline.ts / clauses.ts 一致）：
 *   - 抽不到就留空，不猜。业绩猜错的代价是白做一份标书。
 *   - 每个要素独立判定，一个抽不到不影响其他。
 *   - 「确认没有」（notice='无门槛'）≠「还没抽」（notice=null 且 missing 全量）。
 */

export type PerfField = 'years' | 'fromDate' | 'cnt' | 'minAmount' | 'scope' | 'kind' | 'proof' | 'scale';

export interface PerfReq {
  /** 近 N 年 */
  years: number | null;
  /** 自 YYYY 年 M 月 D 日以来 */
  fromDate: string | null;
  /** N 个/项/宗 */
  cnt: number | null;
  /** 金额门槛，单位**元**（与 price-stats 的 amount > 1000 同单位） */
  minAmount: number | null;
  /** 单项 / 累计 */
  scope: string | null;
  /** 类似 / 同类 / 相应 */
  kind: string | null;
  /** 以竣工验收时间为准 / 中标通知书 / 合同 */
  proof: string | null;
  /** 建筑面积≥2万㎡ / 装机≥20MW */
  scale: string | null;
  /** 原句（≤200 字） */
  evidence: string;
  /** '无门槛' | '见招标文件' | null（null = 有实质门槛，看其他字段；或没找到业绩句） */
  notice: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** 缺哪几个要素，供页面标注 */
  missing: PerfField[];
  /** null = 抽到了或明确无门槛；否则说明为什么没抽到 */
  reason: string | null;
}

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function toNum(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return CN_NUM[s] ?? null;
  // 十一 ~ 十九
  if (s[0] === '十') return 10 + (CN_NUM[s[1]] ?? 0);
  if (s[1] === '十') return (CN_NUM[s[0]] ?? 0) * 10 + (CN_NUM[s[2]] ?? 0);
  return null;
}

/** 「1,200 万元」→ 12000000 元；「1.2 亿元」→ 120000000 元 */
function toYuan(numStr: string, unit: string): number | null {
  const n = Number(numStr.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const yuan = unit.includes('亿') ? n * 1e8 : n * 1e4;
  // 量级闸：1 万 ~ 100 亿。超出说明小数被空格吃掉或抓错了段落
  if (yuan < 1e4 || yuan > 1e10) return null;
  return Math.round(yuan);
}

/** 归一化：与 clauses.ts 同口径（去 HTML → NFKC → 缝合数字间空格） */
function normalize(s: string): string {
  return s
    .replace(/<[^>]{0,80}>/g, ' ')
    .replace(/&[a-z]{2,8};/g, ' ')
    .normalize('NFKC')
    .replace(/(?<=[\d年月日时分秒万])\s+(?=[\d年月日时分秒万])/g, '')
    .replace(/[ \t\u3000]+/g, ' ');
}

/** 「业绩要求：/」「不要求业绩」「无业绩要求」 */
const RE_NO_REQ =
  /业绩(?:要求|门槛)?[^。；]{0,6}?[:：]\s*(?:\/|无|不要求|—|–|-|×|无要求)(?![^。；]{0,4}(?:万元|亿元))|不要求(?:类似|同类|相应)?(?:项目|工程)?业绩|无(?:类似|同类|相应)?(?:项目|工程)?业绩要求/;

/** 「详见招标文件第二章」「见前附表」 */
const RE_DEFER = /详见\s*(?:招标文件|投标人须知|前附表|第二章|第三章)|见\s*(?:招标文件|投标人须知前附表)/;

/**
 * 人员业绩：项目经理 / 总监 / 建造师的业绩要求。
 * 实测 1,106 条「无门槛」的「无/不要求」来自这些子句，而投标人业绩本身是有门槛的 ——
 * 这是**判反**（比抽不到更危险，页面会显示成确定的"本项目不设业绩门槛"）。
 */
const RE_PERSON_PERF = /(项目经理|项目负责人|总监理工程师|技术负责人|建造师|总监)[^。；]{0,6}业绩/;

export function parsePerfReq(fullText: string): PerfReq {
  const text = normalize(fullText || '');
  const base: PerfReq = {
    years: null, fromDate: null, cnt: null, minAmount: null,
    scope: null, kind: null, proof: null, scale: null,
    evidence: '', notice: null, confidence: 'none',
    missing: ['years', 'fromDate', 'cnt', 'minAmount', 'scope', 'kind', 'proof', 'scale'],
    reason: 'no_text',
  };
  if (!text) return base;

  // 1) 切出「业绩句」：含「业绩 / 类似项目 / 同类工程」的第一句
  //    并把下一句也带上 —— 实测有 176 条写成「投标人具有类似项目业绩，详见招标文件第二章」，
  //    只取命中句会漏掉后半句的「详见」，导致这类被误判成"有实质门槛"。
  const sentences = text.split(/[。；]/);
  const idx = sentences.findIndex((s) => /业绩|类似项目|同类工程|同类项目/.test(s));
  if (idx < 0) {
    return { ...base, reason: 'no_perf_sentence' };
  }
  const seg = `${sentences[idx]}。${sentences[idx + 1] ?? ''}`.trim();
  const hitSentence = sentences[idx];
  base.evidence = seg.slice(0, 200);

  // 2) 先判「见招标文件」—— 守卫只测**命中句**，不能被下一句的「共 3 个标段」关掉
  if (RE_DEFER.test(seg) && !/\d+\s*(?:个|项|宗)|不低于|及以上/.test(hitSentence)) {
    return { ...base, notice: '见招标文件', confidence: 'medium', missing: [], reason: null };
  }

  // 3) 「无门槛」的候选：只在命中句上判，且排除人员业绩子句。
  //    但**不能立刻返回** —— 同一句里可能写「业绩数量无要求，但单项合同金额须达到 1000 万」。
  const noReqM = RE_NO_REQ.exec(hitSentence);
  const usNoReq =
    noReqM != null &&
    !RE_PERSON_PERF.test(hitSentence.slice(Math.max(0, noReqM.index - 20), noReqM.index));

  // 3) 五要素各自抽（互不影响）
  const out: PerfReq = { ...base, notice: null };
  const missing: PerfField[] = [];

  // years
  const my = /(?:近|最近)\s*([一二三四五六七八九十\d]{1,3})\s*年/.exec(seg);
  if (my) out.years = toNum(my[1]);
  if (out.years == null) missing.push('years');

  // fromDate —— 「自」字可有可无：实测大量写成「2021 年 1 月 1 日以来」
  const mf = /(?:自|从)?\s*(\d{4})\s*年\s*(\d{1,2})?\s*月?\s*(?:(\d{1,2})\s*日?)?\s*(?:以来|起|以后)/.exec(seg);
  if (mf) {
    out.fromDate = `${mf[1]}-${String(mf[2] ?? 1).padStart(2, '0')}-${String(mf[3] ?? 1).padStart(2, '0')}`;
  }
  if (!out.fromDate) missing.push('fromDate');

  // cnt —— 三个坑都要躲：
  //   「6 个月内」（信誉条款样板句）→ (?!月)
  //   「2.10 项目类别」缝成 2.10项目 → (?<![.\d]) 让 10 无法单独匹配
  //   「共 3 个标段」→ (?!标段)，且要遍历找离「业绩/类似」最近的那个（不能只取首个）
  const RE_CNT = /(?<![.\d])(\d{1,3}|[一二三四五六七八九十]{1,3})\s*(?:个|项|宗)(?!月|标段)/g;
  for (const m of seg.matchAll(RE_CNT)) {
    const n = toNum(m[1]);
    if (n == null || n < 1 || n > 20) continue;
    const around = seg.slice(Math.max(0, (m.index ?? 0) - 24), (m.index ?? 0) + 24);
    if (/业绩|类似|同类/.test(around)) {
      out.cnt = n;
      break;
    }
  }
  if (out.cnt == null) missing.push('cnt');

  // minAmount —— 两种写法都要认：
  //   后置：「不低于 1,000 万元」
  //   前置：「1,000 万元及以上」（实测更常见，只认后置会漏一大半）
  let amount: number | null = null;
  const ma1 = /(?:不低于|不少于|达到)[^。；]{0,10}?([\d,]{1,15}(?:\.\d{1,4})?)\s*(万元|亿元)/.exec(seg);
  if (ma1) amount = toYuan(ma1[1], ma1[2]);
  if (amount == null) {
    const ma2 = /([\d,]{1,15}(?:\.\d{1,4})?)\s*(万元|亿元)\s*(?:及以上|以上|或以上)/.exec(seg);
    if (ma2) amount = toYuan(ma2[1], ma2[2]);
  }
  out.minAmount = amount;
  if (out.minAmount == null) missing.push('minAmount');

  // scope
  const ms = /(单项|单个|累计)/.exec(seg);
  if (ms) out.scope = ms[1];
  if (!out.scope) missing.push('scope');

  // kind
  const mk = /(类似|同类|相应)[^。；]{0,4}?(?:工程|项目|业绩)/.exec(seg);
  if (mk) out.kind = mk[1];
  if (!out.kind) missing.push('kind');

  // proof
  const mp = /以\s*(竣工验收|中标通知书|合同签订|合同|验收)[^。；]{0,6}?为准/.exec(seg);
  if (mp) out.proof = `以${mp[1]}为准`;
  if (!out.proof) missing.push('proof');

  // scale
  const msc = /(建筑面积|装机容量|长度|跨度|规模)[^。；]{0,8}?([\d\.]{1,8})\s*(万平方米|万平方米|平方米|MW|mw|km|公里|米)/.exec(seg);
  if (msc) out.scale = `${msc[1]}≥${msc[2]}${msc[3]}`;
  if (!out.scale) missing.push('scale');

  out.missing = missing;
  const got = 8 - missing.length;

  // 4) 「无门槛」的最终判定：只有命中句写了无/不要求，**且**一个实质要素都没抽到，才算无门槛。
  //    这样「业绩数量无要求，但合同金额须达到 1000 万」会保留实质门槛。
  if (usNoReq && out.cnt == null && out.minAmount == null && out.years == null) {
    return { ...out, notice: '无门槛', confidence: 'high', missing: [], reason: null };
  }

  out.confidence = got >= 3 ? 'high' : got >= 1 ? 'medium' : 'low';
  out.reason = got === 0 ? 'no_field_matched' : null;
  return out;
}
