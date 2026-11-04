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

import { collectPairs, summarize, typeOfTitle } from './lib/price-stats.ts';

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

const pr = db
  .prepare('SELECT MAX(amount) AS a FROM tender_control_price WHERE announcement_guid = ?')
  .get(GUID) as { a: number | null } | undefined;
const limit = pr?.a ?? null;

const type = typeOfTitle(ann.title);
const { pairs, ctrlProjects, winProjects } = collectPairs(db, 'limit');
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
    sameN: same.length,
    same: sameStat,
    all: allStat,
    suggest,
    samples,
    caliber: { ctrlProjects, winProjects },
  },
});
