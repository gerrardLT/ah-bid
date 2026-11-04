/**
 * 投标截止时间抽取（纯函数，零数据库依赖）。
 *
 * 为什么单独成文件：规则是这套东西里风险密度最高的部分，必须有单测；
 * 而扫描器（extract-deadline.ts）只负责 IO 与落库，不写任何正则。
 *
 * 实测背景（8,494 条招标公告）：
 *   - 99.1% 正文含「投标截止时间」
 *   - 关键词后 ≤14 字内有日期：61.4%
 *   - 正/反 25 字窗口并集：82.8%
 *   - 33% 的公告里能找出 ≥2 个不同日期 → 必须消歧
 *
 * 三条铁律（跟 control-price 一个道理）：
 *   1. 抽不到就留空，不猜。错的截止日期比没有更危险。
 *   2. 抽到也要存原文（evidence），让人能一眼复核。
 *   3. 「确认没有」和「还没抽」必须可区分（reason 是否为 null）。
 */

export interface DeadlineHit {
  /** 'YYYY-MM-DD'，抽不到为 null */
  date: string | null;
  /** 'YYYY-MM-DD HH:MM'，只有日期时为 'YYYY-MM-DD' */
  at: string | null;
  /** 'HH:MM'，只到日时为 null（页面显示用） */
  hhmm: string | null;
  /** 命中来源 */
  source: 'bid_deadline' | 'open_time' | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** 正文里一共找到几个候选（33% 有多条，供抽查） */
  candidates: number;
  /** 命中的原文片段（≤120 字） */
  evidence: string;
  /** 抽不到的原因：no_anchor | no_date_near_anchor | all_gated | null */
  reason: string | null;
}

/** 锚点：按优先级从高到低。open_time 是兜底，置信度降一级。 */
const ANCHORS: Array<{ re: RegExp; source: 'bid_deadline' | 'open_time'; conf: 'high' | 'medium' }> = [
  {
    // 「递交」和「提交」都常见（实测正文两种写法各占一半），漏写一种就系统性漏抽
    re: /投标文件(?:递交|提交|送交)的?截止时间|投标截止时间|(?:递交|提交)投标文件的截止时间/g,
    source: 'bid_deadline',
    conf: 'high',
  },
  { re: /递交截止时间|提交截止时间|响应文件提交截止|投标文件接收截止/g, source: 'bid_deadline', conf: 'high' },
  { re: /开标时间|开标日期/g, source: 'open_time', conf: 'medium' },
];

/** 日期：中文式与 ISO 式。分组：年 月 日 [时 [分]] */
const DATE_RE =
  /(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?(?:\s*[T\s]?\s*(\d{1,2})\s*[时:：]\s*(\d{1,2})?)?/g;

/**
 * 间隔词闸：锚点与日期之间出现这些词，说明日期不是截止时间本身，
 * 而是在说"截止时间之前/之后/直到"的某件事。
 *
 * 实测抓到的三类真实误抽（都由这张表挡住）：
 *   1. 「投标截止时间前三个月内的社保证明」           → 前
 *   2. 「获取时间：2026年9月16日至投标截止时间」      → 至（这是范围起点，不是截止日）
 *   3. 「截止时间后不得撤回」                        → 后
 */
const GAP_WORDS = /前|后|内|起|止|至|到|含|不含|延长|顺延|延期|以前|之前|之内/;

/** 窗口：锚点前后各 25 字。实测正/反并集 82.8%，再放大收益很小但误抽上升。 */
const WINDOW = 25;

/** 投标周期合理区间：发布前 1 天 ~ 发布后 180 天。超出必是业绩日期或历史日期。 */
const MAX_SPAN_DAYS = 180;

function toDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayMs(s: string): number {
  return Date.parse(`${s}T00:00:00Z`);
}

/**
 * 归一化：
 * 1. 去 HTML 标签（公告正文常混 <p>、&ldquo;）
 * 2. NFKC：全角数字/冒号 → 半角
 * 3. **空白缝合**：OCR/转版会把日期拆开，如「2 026年9月15日」「2026年 4 月 8 日」
 *    不缝合，「\d{4}年」直接漏 —— 这是系统性漏抽的主因。
 */
function normalize(s: string): string {
  return s
    .replace(/<[^>]{0,80}>/g, ' ')
    .replace(/&[a-z]{2,8};/g, ' ')
    .normalize('NFKC')
    .replace(/(?<=[\d年月日时分秒])\s+(?=[\d年月日时分秒])/g, '');
}

interface Cand {
  date: string;
  hhmm: string | null;
  source: 'bid_deadline' | 'open_time';
  conf: 'high' | 'medium';
  dist: number;
  /** 锚点与日期之间的文字长度。≤NEAR 视为「紧邻」，决定置信度。 */
  gapLen: number;
  evidence: string;
}

/** 紧邻阈值：锚点与日期之间 ≤15 字，通常是「…截止时间为2026年…」这种赋值句。 */
const NEAR = 15;

export function parseDeadline(body: string, pubDate: string): DeadlineHit {
  const text = normalize(body || '');
  if (!text) return { date: null, at: null, hhmm: null, source: null, confidence: 'none', candidates: 0, evidence: '', reason: 'no_text' };

  const pubMs = dayMs((pubDate || '').slice(0, 10));
  const lo = pubMs - 864e5; // 发布前一天（有的公告写"次日开标"）
  const hi = pubMs + MAX_SPAN_DAYS * 864e5;

  const cands: Cand[] = [];
  let anchorSeen = 0;
  let gated = 0;

  for (const a of ANCHORS) {
    a.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = a.re.exec(text)) !== null) {
      anchorSeen++;
      const aStart = m.index;
      const aEnd = m.index + m[0].length;
      const from = Math.max(0, aStart - WINDOW);
      const to = Math.min(text.length, aEnd + WINDOW);
      const win = text.slice(from, to);

      DATE_RE.lastIndex = 0;
      let d: RegExpExecArray | null;
      while ((d = DATE_RE.exec(win)) !== null) {
        const absStart = from + d.index;
        const absEnd = absStart + d[0].length;

        // 间隔词闸：取锚点与日期之间的那段文字
        const gap =
          absStart >= aEnd ? text.slice(aEnd, absStart) : text.slice(absEnd, aStart);
        if (GAP_WORDS.test(gap)) {
          gated++;
          continue;
        }

        const y = Number(d[1]);
        const mo = Number(d[2]);
        const dd = Number(d[3]);
        if (mo < 1 || mo > 12 || dd < 1 || dd > 31) {
          gated++;
          continue;
        }
        const date = `${y}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        const ms = dayMs(date);
        if (Number.isNaN(ms)) {
          gated++;
          continue;
        }
        // 区间闸
        if (ms < lo || ms > hi) {
          gated++;
          continue;
        }

        // 时刻闸：越界只保留日期，置信度不降（日期本身没问题）
        let hhmm: string | null = null;
        if (d[4] !== undefined) {
          const hh = Number(d[4]);
          const mi = d[5] === undefined ? 0 : Number(d[5]);
          if (hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59) {
            hhmm = `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
          }
        }

        cands.push({
          date,
          hhmm,
          source: a.source,
          conf: a.conf,
          dist: Math.abs(absStart - aEnd) + (absStart >= aEnd ? 0 : 5), // 反向稍降权
          gapLen: gap.length,
          evidence: text.slice(Math.max(0, aStart - 20), Math.min(text.length, absEnd + 20)).trim().slice(0, 120),
        });
      }
    }
    // 高优先级锚点找到候选就不再往下降级找（bid_deadline 明显优于 open_time）
    if (cands.some((c) => c.source === a.source)) break;
  }

  if (anchorSeen === 0) {
    return { date: null, at: null, hhmm: null, source: null, confidence: 'none', candidates: 0, evidence: '', reason: 'no_anchor' };
  }
  if (cands.length === 0) {
    return {
      date: null, at: null, hhmm: null, source: null, confidence: 'none', candidates: 0, evidence: '',
      reason: gated > 0 ? 'all_gated' : 'no_date_near_anchor',
    };
  }

  // 消歧分两步：「紧邻」优先（gapLen ≤ NEAR），再按锚点优先级、再按距离。
  // 为什么不能直接在全部候选里取最近：25 字窗口会把邻句日期也收进来，
  // 典型长这样「…时间2026-3-8，开标时间与投标文件递交截止时间为同一时间，2026-3-23…」，
  // 紧邻的那个才是真正赋值给截止时间的。
  const near = cands.filter((c) => c.gapLen <= NEAR);
  const pool = near.length ? near : cands;
  pool.sort((x, y) => {
    if (x.source !== y.source) return x.source === 'bid_deadline' ? -1 : 1;
    return x.gapLen - y.gapLen || x.dist - y.dist;
  });
  const best = pool[0];
  const distinctNear = new Set(pool.map((c) => c.date)).size;

  return {
    date: best.date,
    at: best.hhmm ? `${best.date} ${best.hhmm}` : best.date,
    hhmm: best.hhmm,
    source: best.source,
    // 紧邻里出现两个不同日期 → 原文本身有歧义（多见于更正公告），降为 medium
    confidence: distinctNear > 1 || near.length === 0 ? 'medium' : best.conf,
    candidates: cands.length,
    evidence: best.evidence,
    reason: null,
  };
}
