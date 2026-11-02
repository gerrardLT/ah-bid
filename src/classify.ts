/**
 * 四类业务分类：电力 / 房建 / 光伏 / 储能。
 *
 * 站点没有这些分类字段，只能靠文本匹配。为了能人工复核，每次分类都返回命中证据
 * （哪个词、在标题还是正文、出现几次、贡献多少分），而不是只给一个结论。
 */

import {
  CLASSIFY_RULES,
  TAG_LABELS,
  TAG_PRIORITY,
  SCORE_THRESHOLD,
  TITLE_MULTIPLIER,
  BODY_MULTIPLIER,
  SUPPORTING_MIN_OCCURRENCES,
  type Tag,
} from './config.ts';

export interface Evidence {
  tag: Tag;
  /** 规则名，便于归类 */
  label: string;
  /** 实际命中的原文词（去重后前两个），用于人工复核 */
  matched: string[];
  where: 'title' | 'body';
  occurrences: number;
  points: number;
}

export interface Classification {
  /** 命中的全部类别，可能多个（如"光伏电站升压站"同时是光伏和电力） */
  tags: Tag[];
  /** 按具体度取唯一值，用于统计去重 */
  primaryTag: Tag | null;
  scores: Record<Tag, number>;
  evidence: Evidence[];
}

const EMPTY_SCORES: Record<Tag, number> = { pv: 0, storage: 0, power: 0, building: 0 };

/**
 * 取出所有命中的原文词。
 * 每次都新建 RegExp：带 g 标志的正则对象有 lastIndex 状态，复用会漏计。
 */
function findMatches(re: RegExp, text: string): string[] {
  if (text.length === 0) return [];
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return [...text.matchAll(global)].map((m) => m[0]);
}

/** 证据只保留前两个不同的实际词，避免一行里重复十几次同一个词。 */
function sampleWords(words: string[]): string[] {
  return [...new Set(words)].slice(0, 2);
}

/**
 * 取公告里描述项目本体的那一段。
 *
 * 公告的标准结构是「1.招标条件 → 2.项目概况 → 2.x 建设规模 / 招标内容 → 招标范围」。
 * - 不能直接用全文：招标范围段落会罗列全部专业配套（"包含土建、给排水、电气、
 *   消防、配电工程等"），任何项目都会命中一堆无关类别。
 * - 也不能"截到招标范围之前"：章节标题"2. 项目概况与招标范围"就会被误当成
 *   起点，把真正的建设规模段落整个切掉。
 * 所以直接定位「建设规模 / 招标内容」标记，取其后一段窗口。
 */
const SCALE_MARKER = /(?:建设规模|建设内容|招标内容|工程内容|项目概况)[：:、]/;
const SCALE_WINDOW = 600;

/** 中标结果公示没有"建设规模"段落，改用"项目名称"定位。 */
const NAME_MARKER = /项目名称[：:]?\s*/;
const NO_SCALE_WINDOW = 1200;

export function projectScope(text: string): string {
  const m = SCALE_MARKER.exec(text);
  if (m) {
    const window = text.slice(m.index, m.index + SCALE_WINDOW);
    // 建设规模段落后面经常紧跟招标范围段落，两者可能落在同一个窗口里。
    // 招标范围是专业配套清单，必须挡在窗口之外。
    const scopeStart = /招标范围[：:]/.exec(window);
    return scopeStart ? window.slice(0, scopeStart.index) : window;
  }

  // 中标/候选人公示的结构是"项目名称：X 项目编号：Y 中标单位：Z"，
  // 没有建设规模段落，从项目名称处取一段，否则退回开头。
  const start = NAME_MARKER.exec(text)?.index ?? 0;
  return text.slice(start, start + NO_SCALE_WINDOW);
}

export function classify(title: string, body: string): Classification {
  // 正文开头会原样重复标题，若不剔除，标题里的弱信号会在正文里再命中一次，
  // 导致 "土建工程" 这类市政常用词凑够分数被误判成房建。
  const deduped = title.length > 0 ? body.split(title).join(' ') : body;
  // 只看描述项目本体的那一段，避开招标范围里的专业配套清单
  const bodyOnly = projectScope(deduped);

  const scores: Record<Tag, number> = { ...EMPTY_SCORES };
  const evidence: Evidence[] = [];

  for (const tag of TAG_PRIORITY) {
    for (const rule of CLASSIFY_RULES[tag]) {
      const titleWords = findMatches(rule.re, title);

      if (titleWords.length > 0) {
        // 标题最能代表项目本体，不区分 subject/supporting
        const points = rule.weight * TITLE_MULTIPLIER;
        scores[tag] += points;
        evidence.push({
          tag,
          label: rule.label,
          matched: sampleWords(titleWords),
          where: 'title',
          occurrences: titleWords.length,
          points,
        });
      }

      const bodyWords = findMatches(rule.re, bodyOnly);
      // 配套词必须重复出现才采信：污水处理厂、道路项目正文里提一次"输电线路"
      // 很常见，但那是附属设施，不是项目主体。
      const needed = rule.kind === 'supporting' ? SUPPORTING_MIN_OCCURRENCES : 1;
      if (bodyWords.length >= needed) {
        const points = rule.weight * BODY_MULTIPLIER;
        scores[tag] += points;
        evidence.push({
          tag,
          label: rule.label,
          matched: sampleWords(bodyWords),
          where: 'body',
          occurrences: bodyWords.length,
          points,
        });
      }
    }
  }

  const tags = TAG_PRIORITY.filter((t) => scores[t] >= SCORE_THRESHOLD);

  // primary 按证据强度取，而不是按固定类别优先级：
  // "输变电工区用房（配套屋顶光伏）"这类项目光伏和房建都命中，
  // 但房建证据更重，主体应该归房建。平局时再按具体度排序。
  const primaryTag =
    tags.length === 0
      ? null
      : tags.reduce((best, cur) => {
          if (scores[cur] !== scores[best]) return scores[cur] > scores[best] ? cur : best;
          return TAG_PRIORITY.indexOf(cur) < TAG_PRIORITY.indexOf(best) ? cur : best;
        });

  return { tags, primaryTag, scores, evidence };
}

/** 供报告输出：把证据整理成人能读的一行。 */
export function formatEvidence(c: Classification, limit = 6): string {
  const items = c.evidence
    .slice()
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map(
      (e) =>
        `${TAG_LABELS[e.tag]}/${e.label}[${e.matched.join('|')}]@${e.where === 'title' ? '题' : '文'}×${e.occurrences}+${e.points}`,
    );

  return items.join(' ');
}

/** 存库用的紧凑证据格式，保持与 formatEvidence 一致的语义。 */
export function compactEvidence(c: Classification): string {
  return c.evidence
    .map((e) => `${e.tag}:${e.matched.join('|')}@${e.where}+${e.points}`)
    .join(',');
}
