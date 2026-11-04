/**
 * 下浮率统计的唯一实现：口径分层、项目名归一化、配对去重、分位数。
 *
 * 为什么抽出来：下浮率出现在三个地方（price-benchmark 报告、tech-bid 报价基准、
 * web 模拟器系数），之前各写一套，导致同一件事出现三套互不一致的数字
 * （20.3% / 18.9% / 15.0%）。
 *
 * 三条不可妥协的约束，都是踩坑换来的：
 * 1. 项目名必须【全等】匹配 —— 取前 18 字会把 80.5 万的监理中标价配到 11,489 万
 *    的主体工程控制价上，算出 99.3% 的荒谬下浮率。
 * 2. 口径必须分层 —— 限价与合同估算价是两个子市场，中位数差 3~18 个点。
 *    混在一起算出来的"平均下浮"没有业务含义。
 * 3. 同一项目出现多个不同价格时必须丢弃 —— 多标段项目的控制价是总额、
 *    中标价是单个标段，两者不可比。实测 82 个项目存在多个不同中标价，
 *    之前全部计入样本，属于重复计数 + 口径错配。
 */

import type { DatabaseSync } from 'node:sqlite';

export type Caliber = 'limit' | 'estimate' | 'mixed';

/** 口径 → 纳入的价格类型。mixed 是默认展示口径，分析时必须分层。 */
export const CALIBER_KINDS: Record<Caliber, string[]> = {
  limit: ['限价'],
  estimate: ['估算'],
  mixed: ['限价', '估算', '预算'],
};

export const CALIBER_LABEL: Record<Caliber, string> = {
  limit: '最高投标限价',
  estimate: '合同估算价',
  mixed: '限价+估算（混合）',
};

const SUFFIX =
  /(中标候选人变更公示|中标候选人公示|中标结果公示|中标结果公告|定标候选人公示|成交结果公告|中标公告|招标公告|公开招标公告|采购公告|结果公示|公示|公告)$/g;

/**
 * 项目名归一化：去空白、剥公告后缀、去括号补充说明，**保留完整名称**。
 * 不做截断——截断是错配的根源。
 */
export function normalizeTitle(s: string | null | undefined): string {
  let t = (s ?? '').replace(/[\s　]/g, '');
  for (let i = 0; i < 3; i++) t = t.replace(SUFFIX, '');
  return t.replace(/[（(][^）)]{0,20}[）)]/g, '');
}

/** 价格口径的项目类型。与标准库的 9 类不同：这里只分能算出样本的类型。 */
const TYPE_KW: Record<string, string[]> = {
  监理设计: ['监理', '设计', '勘察', '咨询', '造价'],
  房建: [
    '房屋', '住宅', '安置房', '学校', '校舍', '医院', '厂房', '教学楼', '公寓', '食堂', '楼', '馆', '小区', '装饰', '装修',
    // 教育医疗类常以学段/科室命名，不含「学校/医院」二字（如「第二中学」「妇幼保健院」）
    '中学', '小学', '幼儿园', '大学', '学院', '校区', '教育', '门诊', '住院', '保健院', '卫生院',
  ],
  市政: ['道路', '桥梁', '隧道', '市政', '管网', '排水', '污水', '供水', '燃气', '热力', '管廊', '路面', '顶管', '照明', '整治'],
  园林: ['绿化', '园林', '景观', '公园', '苗木'],
  水利: ['水利', '河道', '水库', '防洪', '灌溉', '泵站', '堤防', '水闸', '航道', '农田'],
  电力: ['供电', '输变电', '变电站', '配电', '线路', '升压站', '电力', '电缆'],
  光伏: ['光伏', '风电', '新能源', '储能', '充电桩', '太阳能'],
  智能化: ['智能化', '弱电', '信息化', '监控', '安防', '智慧', '数据中心'],
};

/** 按顺序匹配：监理设计放最前，否则「XX 项目监理」会被「楼/馆」等词误判。 */
export function typeOfTitle(title: string): string {
  for (const [t, kws] of Object.entries(TYPE_KW)) if (kws.some((k) => title.includes(k))) return t;
  return '其他';
}

export interface PricePair {
  title: string;
  city: string | null;
  type: string;
  kind: string;
  ctrl: number;
  win: number;
  /** 下浮率，0~1 */
  rate: number;
}

export interface Summary {
  n: number;
  avg: number;
  p25: number;
  p50: number;
  p75: number;
  min: number;
  max: number;
}

export interface CollectResult {
  pairs: PricePair[];
  /** 控制价项目数（归一化后、口径内） */
  ctrlProjects: number;
  /** 中标价项目数（归一化后、有价） */
  winProjects: number;
  /** 因多标段（同项目多个不同价格）被丢弃的项目数 */
  droppedCtrl: number;
  droppedWin: number;
  /** 双闸剔除：下浮率越界或量级不合理 */
  droppedGate: number;
}

/** 同一 key 的多个价格：完全一致则取一个，否则判为多标段、返回 null。 */
function singlePrice<T>(items: T[], pick: (x: T) => number): T | null {
  if (items.length === 0) return null;
  const uniq = new Set(items.map((x) => Math.round(pick(x) * 100)));
  return uniq.size === 1 ? items[0] : null;
}

/**
 * 单项目价格（全站唯一入口）。
 *
 * 为什么要单独一个函数：库里 494 个公告**只有估算没有限价**，而三处调用都在用
 * `MAX(amount)` 不区分 price_kind —— 估算价被当成"投标上限"去乘 (1−限价口径下浮率)，
 * 建议报价会系统性偏高。全站只允许这一个地方回答"这个项目多少钱"。
 *
 * 优先级：限价 > 估算 > 预算。同一公告同一口径有多行（多标段）时取最大，
 * 并在 kind 上标注，让页面能显示"估算价（非投标上限）"。
 */
export interface ProjectPrice {
  amount: number | null;
  /** 限价 | 估算 | 预算 | null */
  kind: string | null;
  /** 同口径有几行（>1 说明多标段，金额取的是最大值） */
  rows: number;
}

const PRICE_RANK: Record<string, number> = { 限价: 0, 估算: 1, 预算: 2, 其他: 3 };

export function projectPrice(db: DatabaseSync, guid: string): ProjectPrice {
  if (!guid) return { amount: null, kind: null, rows: 0 };
  const rows = db
    .prepare(
      `SELECT price_kind AS kind, MAX(amount) AS amount, COUNT(*) AS n
       FROM tender_control_price WHERE announcement_guid = ? AND amount > 1000
       GROUP BY price_kind`,
    )
    .all(guid) as unknown as Array<{ kind: string; amount: number; n: number }>;
  if (rows.length === 0) return { amount: null, kind: null, rows: 0 };
  rows.sort((a, b) => (PRICE_RANK[a.kind] ?? 9) - (PRICE_RANK[b.kind] ?? 9));
  return { amount: rows[0].amount, kind: rows[0].kind, rows: rows[0].n };
}

/**
 * 取控制价：同一项目名（归一化后）有多个不同金额 → 丢弃，避免把多标段的
 * 分标段限价当成整个项目，或反过来。
 */
function loadControl(db: DatabaseSync, caliber: Caliber): {
  map: Map<string, { amount: number; kind: string; title: string }>;
  projects: number;
  dropped: number;
} {
  const kinds = CALIBER_KINDS[caliber];
  const ph = kinds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT title, amount, price_kind FROM tender_control_price
       WHERE price_kind IN (${ph}) AND amount > 1000 AND title IS NOT NULL`,
    )
    .all(...kinds) as Array<{ title: string; amount: number; price_kind: string }>;

  const groups = new Map<string, Array<{ title: string; amount: number; price_kind: string }>>();
  for (const r of rows) {
    const k = normalizeTitle(r.title);
    if (!k) continue;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  const map = new Map<string, { amount: number; kind: string; title: string }>();
  let dropped = 0;
  for (const [k, arr] of groups) {
    const one = singlePrice(arr, (x) => x.amount);
    if (!one) {
      dropped++;
      continue;
    }
    map.set(k, { amount: one.amount, kind: one.price_kind, title: one.title });
  }
  return { map, projects: groups.size, dropped };
}

/**
 * 取中标价：正文来源（bid_body_result，high）优先，附件来源（bid_result）补充。
 * 同一项目多个不同价格 → 丢弃（多标段，无法确定对应关系）。
 */
function loadWin(db: DatabaseSync): {
  map: Map<string, { price: number; title: string; city: string | null }>;
  projects: number;
  dropped: number;
} {
  const rows: Array<{ title: string; city: string | null; price: number }> = [];
  for (const r of db
    .prepare(
      `SELECT title, city, winner_price price FROM bid_body_result
       WHERE winner IS NOT NULL AND winner_price >= 1000 AND confidence = 'high'`,
    )
    .all() as Array<{ title: string; city: string | null; price: number }>) {
    rows.push(r);
  }
  for (const r of db
    .prepare(
      `SELECT a.title, a.city, b.winner_price price
       FROM bid_result b JOIN announcement a ON a.guid = b.announcement_guid
       WHERE b.winner_price >= 1000`,
    )
    .all() as Array<{ title: string; city: string | null; price: number }>) {
    rows.push(r);
  }

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = normalizeTitle(r.title);
    if (!k) continue;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  const map = new Map<string, { price: number; title: string; city: string | null }>();
  let dropped = 0;
  for (const [k, arr] of groups) {
    const one = singlePrice(arr, (x) => x.price);
    if (!one) {
      dropped++;
      continue;
    }
    map.set(k, { price: one.price, title: one.title, city: one.city });
  }
  return { map, projects: groups.size, dropped };
}

/**
 * 配对并做合理性双闸：
 *   ① 下浮率 ∈ (-5%, 45%) —— 工程类极少超过 45%，越界必是错配或单位错误
 *   ② 中标价/控制价 ≥ 0.55 —— 低于此值说明控制价可能是总额而中标价是单标段
 */
export function collectPairs(db: DatabaseSync, caliber: Caliber = 'limit'): CollectResult {
  const ctrl = loadControl(db, caliber);
  const win = loadWin(db);

  const pairs: PricePair[] = [];
  let droppedGate = 0;
  for (const [k, c] of ctrl.map) {
    const w = win.map.get(k);
    if (!w) continue;
    const rate = (c.amount - w.price) / c.amount;
    if (rate < -0.05 || rate > 0.45) {
      droppedGate++;
      continue;
    }
    if (w.price / c.amount < 0.55) {
      droppedGate++;
      continue;
    }
    pairs.push({
      title: w.title,
      city: w.city,
      type: typeOfTitle(w.title),
      kind: c.kind,
      ctrl: c.amount,
      win: w.price,
      rate,
    });
  }

  return {
    pairs,
    ctrlProjects: ctrl.projects,
    winProjects: win.projects,
    droppedCtrl: ctrl.dropped,
    droppedWin: win.dropped,
    droppedGate,
  };
}

/** 分位数用最近秩法，样本量小时不会像线性插值那样给出不存在的值。 */
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i];
}

export function summarize(values: number[]): Summary {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    avg: s.reduce((a, b) => a + b, 0) / (s.length || 1),
    p25: quantile(s, 0.25),
    p50: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    min: s[0],
    max: s[s.length - 1],
  };
}

export interface TypeStat {
  type: string;
  n: number;
  avg: number;
  p50: number;
}

/** 按项目类型分组统计（只返回 n ≥ minN 的类型）。 */
export function groupByType(pairs: PricePair[], minN = 3): TypeStat[] {
  const by = new Map<string, number[]>();
  for (const p of pairs) {
    const arr = by.get(p.type);
    if (arr) arr.push(p.rate * 100);
    else by.set(p.type, [p.rate * 100]);
  }
  return [...by.entries()]
    .filter(([, v]) => v.length >= minN)
    .map(([type, v]) => {
      const s = summarize(v);
      return { type, n: s.n, avg: s.avg, p50: s.p50 };
    })
    .sort((a, b) => b.n - a.n);
}
