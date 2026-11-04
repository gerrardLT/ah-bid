/**
 * 资格条件抽取（纯函数，零数据库依赖）。
 *
 * 为什么值得做：日报现在告诉你"还有 3 天截止"，但不告诉"你没有市政一级资质，投不了"。
 * 实测正文「投标人资格要求」段命中 7,330/8,494（86.3%），76.8% 能切到下一个章节。
 *
 * 三条纪律（照抄 deadline.ts，那是本项目唯一验证过的抽取器）：
 *   1. 抽不到就留空，不猜。资格条件猜错的代价是"白做一份标书"。
 *   2. 存 evidence 原文，让人能一眼复核。
 *   3. **「确认没有」≠「还没抽」**：原文写"不接受联合体"是有效信息（jointVenture=0），
 *      和"没提这件事"（null）必须区分。
 */

export interface ClauseHit {
  /** 资质要求原文，如「建筑工程施工总承包一级」 */
  qualification: string | null;
  /** 建造师要求，如「一级建造师（建筑工程）」 */
  builder: string | null;
  /** 业绩门槛，如「近3年1个类似业绩」 */
  performance: string | null;
  /** 0=明确不接受联合体，1=接受，null=没提 */
  jointVenture: 0 | 1 | null;
  /** 命中的资格要求段原文（≤600 字，供人工复核） */
  qualText: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** null = 抽到了（含"明确没有"）；否则说明为什么没抽到 */
  reason: string | null;
}

/** 资格要求段的起点。注意正文是一整行（没有换行），只能靠标题词定位。 */
const SEC_START =
  /(?:投标人|申请人|供应商|投标单位)[^。；]{0,6}?(?:资格(?:要求|条件)|资质(?:要求|等级))|资格(?:审查|预审)(?:要求|条件)/;

/** 下一个大章节，用来截断资格段 */
const SEC_END =
  /(?:招标文件的获取|获取招标文件|投标文件的(?:获取|递交|编制|组成)|投标报名|开标时间|评标办法|评标标准|投标保证金的(?:递交|缴纳))/;

/** 资质：企业资质等级。等级用大写「壹贰叁肆」在政府文件里极常见（实测漏抽主因） */
const RE_QUAL =
  /(?:具备|具有|须具备|应具备|要求)[^。；]{0,40}?((?:建筑工程|市政公用工程|公路工程|水利水电工程|电力工程|机电工程|通信工程|矿山工程|冶金工程|石油化工工程|园林绿化|电子与智能化|建筑装修装饰|钢结构|地基基础|消防设施|防水防腐保温|环保工程|城市及道路照明)[^。；]{0,12}?(?:施工总承包|专业承包)[^。；]{0,6}?(?:特级|[一二三壹贰叁]级|甲级|乙级|丙级))|((?:工程勘察|工程设计|工程监理)[^。；]{0,8}?(?:综合|行业|专业)?[^。；]{0,6}?(?:甲级|乙级|丙级|特级))/;

/** 建造师 */
const RE_BUILDER =
  /((?:一级|二级)?注册建造师|(?:一级|二级)建造师)[^。；]{0,30}?((?:建筑工程|市政公用工程|公路工程|水利水电工程|机电工程|矿业工程|通信与广电工程))?/;

/** 业绩：写法比资质乱得多，单位可能是「个/项/宗」，结果词可能是「业绩/工程/项目」 */
const RE_PERF =
  /近\s*(\d+|三|五|八)\s*年[^。；]{0,40}?(\d+)\s*(?:个|项|宗)[^。；]{0,25}?(类似|同类|相应)[^。；]{0,12}?(?:业绩|工程|项目)/;

/**
 * 联合体。实测最容易误判的一处：
 *   表格字段「是否接受联合体投标：否」—— 含「接受联合体」，但答案是「否」。
 * 所以必须先判否定式（含冒号否），再判肯定式，最后才落到宽松匹配。
 */
const RE_JV_NO =
  /不接受联合体|不允许联合体|不得组成联合体|(?:是否)?接受联合体[^。；]{0,8}?[:：]\s*(?:否|不允许|不接受)|联合体[^。；]{0,6}?[:：]\s*不接受/;
const RE_JV_YES =
  /(?:是否)?接受联合体[^。；]{0,8}?[:：]\s*是|接受联合体|允许联合体|可组成联合体/;

/**
 * 正文归一化。
 *
 * 与 deadline 的 normalize 是同一套（去 HTML → NFKC → 空白缝合），
 * 但这里**不缝合数字之间的空格**会漏掉「近 3 年」，所以保留缝合。
 */
function normalize(s: string): string {
  return s
    .replace(/<[^>]{0,80}>/g, ' ')
    .replace(/&[a-z]{2,8};/g, ' ')
    .normalize('NFKC')
    .replace(/(?<=[\d年月日时分秒])\s+(?=[\d年月日时分秒])/g, '')
    .replace(/[ \t\u3000]+/g, ' ');
}

export function parseClauses(body: string): ClauseHit {
  const text = normalize(body || '');
  const empty: ClauseHit = {
    qualification: null, builder: null, performance: null, jointVenture: null,
    qualText: '', confidence: 'none', reason: 'no_text',
  };
  if (!text) return empty;

  // 1) 定位资格要求段
  const m = SEC_START.exec(text);
  if (!m) {
    // 整篇都没提"资格要求" —— 可能是资格预审公告或极简公告
    return { ...empty, reason: 'no_section' };
  }
  const from = m.index;
  const rest = text.slice(from);
  const endAt = SEC_END.exec(rest.slice(50)); // 跳过起点本身，避免"投标文件的获取"就在标题里
  // 段长上限 1600 字：实测资格段平均 600-1200 字，超过说明没找到下一章节
  const len = endAt ? 50 + endAt.index : Math.min(1600, rest.length);
  const seg = rest.slice(0, Math.min(len, 2000));

  if (seg.length < 30) {
    return { ...empty, qualText: seg, reason: 'section_too_short' };
  }

  // 2) 在段内抽
  const qual = RE_QUAL.exec(seg);
  const qualStr = qual ? (qual[1] ?? qual[2] ?? '').trim() : null;

  const bld = RE_BUILDER.exec(seg);
  const builderStr = bld
    ? (bld[1] + (bld[2] ? `（${bld[2]}）` : '')).trim()
    : null;

  const perf = RE_PERF.exec(seg);
  const perfStr = perf
    ? `近${perf[1]}年${perf[2]}个${perf[3]}业绩`
    : null;

  // 联合体判定：先看表格字段「是否接受联合体 : <答案>」，再退回整段匹配。
  // 为什么字段优先：实测「是否接受联合体 : 本次招标不接受联合体投标」这种写法，
  // 纯正则会被其中的「接受联合体」三个字骗到（冒号后还有 7 个字才出现"不接受"）。
  let jv: 0 | 1 | null = null;
  const jvField = /是否(?:接受|允许)联合体[^。；]{0,10}?[:：]([^。；]{0,30})/.exec(seg);
  if (jvField) {
    const ans = jvField[1];
    if (/不接受|不允许|不得组成|否/.test(ans)) jv = 0;
    else if (/接受|允许|是/.test(ans)) jv = 1;
  }
  if (jv === null) {
    if (RE_JV_NO.test(seg)) jv = 0;
    else if (RE_JV_YES.test(seg)) jv = 1;
  }

  const got = [qualStr, builderStr, perfStr].filter(Boolean).length + (jv !== null ? 1 : 0);

  return {
    qualification: qualStr || null,
    builder: builderStr,
    performance: perfStr,
    jointVenture: jv,
    // 存 600 字：联合体条款常常在资格段的后半部分，300 字会截断到「无法复核」。
    qualText: seg.replace(/\s+/g, ' ').slice(0, 600),
    // 4 项里抽到 2 项以上算 high；抽到 1 项 medium；一项都没有说明这段不是资格段
    confidence: got >= 2 ? 'high' : got === 1 ? 'medium' : 'low',
    reason: got === 0 ? 'no_field_matched' : null,
  };
}
