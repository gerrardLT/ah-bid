/**
 * 全量抓取器（2026 年，四类业务tag）。
 *
 * 三个设计约束都来自实测：
 * 1. 不预先枚举页数：列表按时间倒序，遇到整页早于 --since 就停，自动适应数据增长。
 * 2. 断点续传到页级：跑几小时的任务必须能中断恢复，状态存 crawl_state 表。
 * 3. 绝不并发：该站点对速率极敏感，快一点就返回 1484 字节的假成功响应，
 *    并发只会制造无声的数据缺失。
 *
 * 用法：
 *   node src/crawl.ts --probe                      # 只探测数据量，不抓详情
 *   node src/crawl.ts --natures=1                  # 抓招标公告
 *   node src/crawl.ts --natures=2,3                # 抓中标类
 *   node src/crawl.ts --reset=1:1                  # 重置某个组合的断点
 */

import { IndexDb } from './db.ts';
import { classify } from './classify.ts';
import { TAG_LABELS, type Tag } from './config.ts';
import { fetchListPageMeta, fetchDetail, type ListItem } from './source/provincial.ts';

interface Args {
  db: string;
  since: string;
  types: string[];
  natures: string[];
  probe: boolean;
  status: boolean;
  retryFailed: boolean;
  maxPages: number;
  /** 形如 1:1,2:1，重置这些组合的断点 */
  reset: Array<[string, string]>;
  logEvery: number;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, d: string) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };

  return {
    db: get('db', 'data/index.db'),
    since: get('since', '2026-01-01'),
    types: get('types', '1,2,3,4,5').split(',').filter(Boolean),
    natures: get('natures', '1').split(',').filter(Boolean),
    probe: argv.includes('--probe'),
    status: argv.includes('--status'),
    retryFailed: argv.includes('--retry-failed'),
    maxPages: Number(get('max-pages', '20000')),
    reset: get('reset', '')
      .split(',')
      .filter(Boolean)
      .map((s) => s.split(':') as [string, string]),
    logEvery: Number(get('log-every', '25')),
  };
}

const args = parseArgs(process.argv.slice(2));
const db = new IndexDb(args.db);

// --reset=all：重置所有 types × natures 组合。
// 日常增量必须用它 —— 断点已 finished=1 时直接跑会自动跳过（日志里那句提醒），
// 而逐个列 15 个组合（1:1,1:2,...,5:3）在 bat/计划任务里没法维护。
const resetPairs: Array<[string, string]> = args.reset.some(([t]) => t === 'all')
  ? args.types.flatMap((t) => args.natures.map((n) => [t, n] as [string, string]))
  : args.reset;
for (const [t, n] of resetPairs) {
  db.saveCrawlState(t, n, 1, false, 0);
  console.log(`已重置断点 ${t}:${n}`);
}

const startedAt = Date.now();
const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(0);

// ============ 状态查询 ============
if (args.status) {
  const states = db.db
    .prepare(
      `SELECT tender_project_type AS t, bulletin_nature AS n, next_page AS p,
              finished, scanned, updated_at
       FROM crawl_state ORDER BY t, n`,
    )
    .all() as Array<{ t: string; n: string; p: number; finished: number; scanned: number; updated_at: string }>;

  console.log('组合  下一页  状态      已扫描  更新时间');
  for (const s of states) {
    const st = s.finished === 1 ? '已完成' : '进行中';
    console.log(`${s.t}:${s.n}   ${String(s.p).padEnd(6)} ${st}  ${String(s.scanned).padEnd(7)} ${s.updated_at}`);
  }
  if (states.length === 0) console.log('（无断点记录）');
  console.log(`\n库内 ${db.count()} 条，失败 ${db.failureCount()} 条`);
  db.close();
  process.exit(0);
}

// ============ 补跑失败项 ============
// 首次全量跑完时发现 1:1 的第 572-624 页连续 53 页失败（约 21 分钟窗口），
// 那是 2026 年 1 月初的数据，不能因为一次故障就当它不存在。
if (args.retryFailed) {
  const failures = db.allFailures();
  const listFails = failures.filter((f) => f.stage === 'list');
  const detailFails = failures.filter((f) => f.stage === 'detail');
  console.log(`待补跑：列表 ${listFails.length} 页，详情 ${detailFails.length} 条`);

  let listOk = 0;
  let listStill = 0;
  let detailOk = 0;
  let detailStill = 0;
  let added = 0;

  for (const f of listFails) {
    const page = Number(/第(\d+)页/.exec(f.title)?.[1] ?? 0);
    if (!page) continue;

    try {
      const { items } = await fetchListPageMeta({
        tenderProjectType: f.tenderProjectType,
        bulletinNature: f.bulletinNature,
        page,
      });

      let pageAdded = 0;
      for (const item of items) {
        if (item.pubDate < args.since) continue;
        if (db.has(item.guid)) continue;
        try {
          const detail = await fetchDetail(item);
          if (detail.bytes < 500) continue;
          db.upsert({ item, detail, classification: classify(item.title, detail.text) });
          pageAdded++;
          added++;
        } catch (err) {
          db.recordFailure(item, 'detail', String(err));
        }
      }

      db.removeFailure(f.guid);
      listOk++;
      console.log(`  ✓ ${f.tenderProjectType}:${f.bulletinNature} 第${page}页 补回 ${pageAdded} 条`);
    } catch (err) {
      listStill++;
      console.log(`  ✗ ${f.tenderProjectType}:${f.bulletinNature} 第${page}页 仍失败：${String(err).slice(0, 60)}`);
    }
  }

  // 详情失败项重抓。这些条目从未成功入库，所以列表元数据（城市/日期）已丢失，
  // 先用空值入库、保留原文链接，后续可从原站补齐。
  for (const f of detailFails) {
    const stub: ListItem = {
      guid: f.guid,
      tenderProjectType: f.tenderProjectType,
      bulletinNature: f.bulletinNature,
      area: '',
      city: '',
      district: '',
      title: f.title,
      pubDate: '',
      projectType: '',
      natureLabel: '',
    };
    try {
      const detail = await fetchDetail(stub);
      if (detail.bytes < 500) throw new Error(`内容过短 ${detail.bytes}`);
      db.upsert({ item: stub, detail, classification: classify(stub.title, detail.text) });
      db.removeFailure(f.guid);
      detailOk++;
    } catch {
      detailStill++;
    }
  }

  console.log(`\n补跑结果：列表恢复 ${listOk} 页，仍失败 ${listStill} 页；详情恢复 ${detailOk} 条，仍失败 ${detailStill} 条`);
  console.log(`新增入库 ${added} 条，库内总计 ${db.count()} 条，剩余失败 ${db.failureCount()} 条`);
  db.close();
  process.exit(0);
}

// ============ 阶段 0：探测数据量 ============
// 用二分找 2026 边界，而不是从第 1 页线性翻到底。
// 建筑工程一类的 2026 数据约 580 页，线性探测要 22 分钟，二分只需 log2(2300)≈12 次请求。
if (args.probe) {
  interface ProbeRow {
    type: string;
    nature: string;
    totalPages: number;
    pages2026: number;
    est2026: number;
    newest: string;
    oldest2026: string;
  }
  const rows: ProbeRow[] = [];

  for (const type of args.types) {
    for (const nature of args.natures) {
      let totalPages = 0;
      let pages2026 = 0;
      let newest = '';
      let oldest2026 = '';

      try {
        const first = await fetchListPageMeta({ tenderProjectType: type, bulletinNature: nature, page: 1 });
        totalPages = first.totalPages;
        newest = first.items[0]?.pubDate ?? '';

        if (newest >= args.since && totalPages > 0) {
          // 二分：找最后一个「含 2026 数据」的页
          let lo = 1;
          let hi = totalPages;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (mid === lo) break;
            const pg = await fetchListPageMeta({ tenderProjectType: type, bulletinNature: nature, page: mid });
            if (pg.items.some((i) => i.pubDate >= args.since)) lo = mid;
            else hi = mid - 1;
          }
          pages2026 = lo;

          const last = await fetchListPageMeta({ tenderProjectType: type, bulletinNature: nature, page: lo });
          oldest2026 = last.items.filter((i) => i.pubDate >= args.since).at(-1)?.pubDate ?? '';
        }
      } catch (err) {
        console.log(`  ! ${type}:${nature} 探测失败：${String(err).slice(0, 80)}`);
      }

      rows.push({
        type,
        nature,
        totalPages,
        pages2026,
        est2026: pages2026 * 10, // 末页可能不满 10 条，上限估算
        newest,
        oldest2026,
      });
      console.log(
        `  ${type}:${nature} 总页=${totalPages} 2026页=${pages2026} 约${pages2026 * 10}条 ` +
          `最新=${newest} 2026最早=${oldest2026}`,
      );
    }
  }

  const sum = rows.reduce((a, r) => a + r.est2026, 0);
  const listSeconds = rows.reduce((a, r) => a + r.pages2026, 0) * 1.5;
  const detailSeconds = sum * 1.5;

  console.log('\n=== 探测汇总 ===');
  console.log('| type | nature | 总页 | 2026页 | 估计条数 |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.type} | ${r.nature} | ${r.totalPages} | ${r.pages2026} | ${r.est2026} |`);
  }
  console.log(`\n合计估计 ${sum} 条`);
  console.log(`列表耗时约 ${(listSeconds / 60).toFixed(0)} 分钟，详情耗时约 ${(detailSeconds / 3600).toFixed(1)} 小时`);
  console.log(`合计约 ${((listSeconds + detailSeconds) / 3600).toFixed(1)} 小时`);
  console.log(`探测耗时 ${elapsed()} 秒`);
  db.close();
  process.exit(0);
}
// ============ 正式抓取 ============
let processed = 0;
let skipped = 0;
let failed = 0;
let listFailed = 0;

/** 每页抓完后立即落断点，崩溃也能从这一页继续。 */
function persist(type: string, nature: string, nextPage: number, finished: boolean, scanned: number): void {
  db.saveCrawlState(type, nature, nextPage, finished, scanned);
}

for (const type of args.types) {
  for (const nature of args.natures) {
    const state = db.getCrawlState(type, nature);
    if (state.finished) {
      console.log(`[${type}:${nature}] 已完成，跳过`);
      continue;
    }

    console.log(`\n[${type}:${nature}] 从第 ${state.nextPage} 页开始`);
    let scanned = state.scanned;
    let finished = false;
    /** 连续多少页“全无 2026 数据”，连续 3 页才判定越过时间边界 */
    let consecutiveOld = 0;
    /** 列表总页数，从第 1 页尾部“共 N 页”取，用于防死循环 */
    let totalPages = 0;

    for (let page = state.nextPage; page <= args.maxPages; page++) {
      // 超过服务端声明的总页数就真的结束了
      if (totalPages > 0 && page > totalPages) {
        finished = true;
        persist(type, nature, page, true, scanned);
        console.log(`  已翻过总页数 ${totalPages}，本组合结束`);
        break;
      }

      let items: ListItem[] = [];
      try {
        const meta = await fetchListPageMeta({
          tenderProjectType: type,
          bulletinNature: nature,
          page,
        });
        items = meta.items;
        if (meta.totalPages > 0) totalPages = meta.totalPages;
      } catch (err) {
        listFailed++;
        db.recordFailure(
          { guid: `list:${type}:${nature}:${page}`, tenderProjectType: type, bulletinNature: nature, title: `列表第${page}页` },
          'list',
          String(err),
        );
        console.log(`  ! 列表第 ${page} 页失败，跳过：${String(err).slice(0, 80)}`);
        persist(type, nature, page + 1, false, scanned);
        continue;
      }

      // 空页不等于列表结束：实测该站存在服务端空页（2:3 第 13 页返回 0 条，
      // 第 14 页又有数据），当成结束会直接丢掉后面全部数据。
      if (items.length === 0) {
        console.log(`  第 ${page} 页为空，继续翻页`);
        persist(type, nature, page + 1, false, scanned);
        continue;
      }

      const inRange = items.filter((i) => i.pubDate >= args.since);
      scanned += inRange.length;

      // 整页早于起始日期：可能是真边界，也可能是局部乱序/空页后的残留，
      // 要求连续 3 页都如此才终止。
      if (inRange.length === 0) {
        consecutiveOld++;
        if (consecutiveOld >= 3) {
          finished = true;
          persist(type, nature, page + 1, true, scanned);
          console.log(`  连续 ${consecutiveOld} 页早于 ${args.since}，本组合结束`);
          break;
        }
        persist(type, nature, page + 1, false, scanned);
        continue;
      }
      consecutiveOld = 0;

      for (const item of inRange) {
        if (db.has(item.guid)) {
          skipped++;
          continue;
        }
        try {
          const detail = await fetchDetail(item);
          if (detail.bytes < 500) {
            failed++;
            db.recordFailure(item, 'detail', `内容过短 ${detail.bytes} 字节`);
            continue;
          }
          db.upsert({ item, detail, classification: classify(item.title, detail.text) });
          processed++;
        } catch (err) {
          failed++;
          db.recordFailure(item, 'detail', String(err));
        }

        if (processed > 0 && processed % args.logEvery === 0) {
          const rate = processed / ((Date.now() - startedAt) / 1000);
          console.log(
            `  page=${page} 新入库=${processed} 跳过=${skipped} 失败=${failed} ` +
              `速度=${rate.toFixed(2)}条/秒 已用=${elapsed()}s`,
          );
        }
      }

      persist(type, nature, page + 1, false, scanned);
    }

    if (finished) persist(type, nature, state.nextPage, true, scanned);
  }
}

// ============ 收尾 ============
const total = db.count();
const byTag = db.statsByTag();

console.log('\n=== 抓取完成 ===');
console.log(`新入库 ${processed} 条，跳过已存在 ${skipped} 条，失败 ${failed} 条，列表失败 ${listFailed} 页`);
console.log(`库内总计 ${total} 条，耗时 ${elapsed()} 秒`);

console.log('\n分类分布：');
for (const r of byTag) {
  console.log(`  ${r.tag ? TAG_LABELS[r.tag as Tag] : '(未归类)'}  ${r.n}`);
}

const failures = db.listFailures(10);
if (failures.length > 0) {
  console.log(`\n失败样本（共 ${db.failureCount()} 条）：`);
  for (const f of failures) {
    console.log(`  [${f.stage}] ${f.title.slice(0, 40)} :: ${f.reason.slice(0, 80)}`);
  }
  console.log('  可用 node src/crawl.ts --reset 重跑，或直接重跑（已入库会自动跳过）');
}

db.close();
