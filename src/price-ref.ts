/**
 * 报价参考：给定一个项目，用同类项目的下浮率分布算「该报多少」。
 *
 * 为什么单独一个 CLI：下浮率的配对、双闸剔除、分位计算都在 lib/price-stats.ts 里，
 * 在这里重写一遍会分叉。server.py 调本脚本拿 JSON，页面只负责展示。
 *
 * 口径说明：
 * - 默认用 limit（限价 vs 中标价）。estimate（估算价）只在没有限价时才有意义，
 *   两者混用会把下浮率系统性拉偏，所以不混。
 * - 同类样本 n<5 时不出建议区间，只给全库参考并标注「同类样本不足」。
 * - 「同类」= typeOfTitle 推断的项目类型（房建/市政/光伏…），不是工程类型字段。
 *
 * 用法：
 *   node --no-warnings src/price-ref.ts --g=<guid>
 */

import { DatabaseSync } from 'node:sqlite';

import { collectPairs, projectPrice, summarize, typeOfTitle, type Caliber } from './lib/price-stats.ts';

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const GUID = argOf('g') ?? '';

const out = (o: unknown): void => {
  console.log(JSON.stringify(o, null, 2));
};

const db = new DatabaseSync('data/index.db', { readOnly: true });

const ann = db
  .prepare('SELECT title, city, pub_date AS pubDate FROM announcement WHERE guid = ?')
  .get(GUID) as { title: string; city: string; pubDate: string } | undefined;
if (!ann) {
  db.close();
  out({ ok: false, error: '项目不存在' });
  // 用 throw 而不是 process.exit：exit 的类型标注依赖 @types/node（本项目没有），
  // TS 看不出分支不返回，下面所有 ann.xxx 都会被报「可能未定义」。
  throw new Error('project not found');
}

// 本项目价格：走全站唯一入口，带口径（限价/估算/预算）。
// 原来这里是 SELECT MAX(amount) 不区分口径 —— 494 个"只有估算"的项目
// 会被当成投标上限去乘 (1−下浮率)，建议报价系统性偏高。
const price = projectPrice(db, GUID);
const limit = price.amount;

const type = typeOfTitle(ann.title);

// 口径回退：项目本身是估算价时，优先用估算口径的下浮率。
// 但实测估算口径只有 51 对配对，样本不足就退回限价口径并显式标注 ——
// 宁可告诉用户"这里用的是限价口径"，也不要拿 8 个样本算出一个看起来精确的中位数。
let caliber: Caliber = price.kind === '估算' ? 'estimate' : 'limit';
let res = collectPairs(db, caliber);
let basisOn: Caliber = caliber;
if (caliber === 'estimate' && res.pairs.length < 30) {
  res = collectPairs(db, 'limit');
  basisOn = 'limit';
}
const { pairs, ctrlProjects, winProjects } = res;
db.close();

const same = pairs.filter((p) => p.type === type);
const sameStat = same.length >= 5 ? summarize(same.map((p) => p.rate)) : null;
const allStat = summarize(pairs.map((p) => p.rate));

// 建议报价：下浮越高报价越低。给 P25~P75 区间，中间用中位数。
const suggest =
  limit && sameStat
    ? {
        low: Math.round(limit * (1 - sameStat.p75)),
        mid: Math.round(limit * (1 - sameStat.p50)),
        high: Math.round(limit * (1 - sameStat.p25)),
      }
    : null;

// 同类型里，控制价最接近本项目的 3 个样本，比"随便取 3 个"更可参考
const samples = [...same]
  .sort((a, b) => Math.abs(a.ctrl - (limit ?? 0)) - Math.abs(b.ctrl - (limit ?? 0)))
  .slice(0, 3)
  .map((p) => ({ title: p.title, city: p.city, ctrl: p.ctrl, win: p.win, rate: p.rate }));

out({
  ok: true,
  data: {
    title: ann.title,
    city: ann.city,
    pubDate: ann.pubDate,
    type,
    limit,
    /** 限价 | 估算 | 预算 | null —— 页面据此决定标「限价」还是「估算价（非投标上限）」 */
    limitKind: price.kind,
    /** 下浮率取自哪个口径。项目是估算价但这里写 limit，说明估算样本不足、用了限价基准 */
    basis: basisOn,
    sameN: same.length,
    same: sameStat,
    all: allStat,
    suggest,
    samples,
    caliber: { ctrlProjects, winProjects },
  },
});
