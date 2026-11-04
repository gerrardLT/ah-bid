/**
 * 招标日报：抓最近 N 天新发布的招标公告，汇总成一条消息，按配置推送。
 *
 * 三个设计决定：
 * 1. **按发布日期（pub_date）而不是抓取时间**筛选 —— 用户关心的是"最近有哪些新标"，
 *    补抓进来的旧公告不该混进日报。
 * 2. **渠道可配置、缺失即降级** —— 没填 webhook 就只写文件，不报错。
 *    这样脚本能直接挂进定时任务，用户想推送时填配置即可。
 * 3. **企业微信用纯文本列表而不是 Markdown 表格** —— 企微 markdown 对表格支持不稳，
 *    列多了会错行；列表在所有渠道都能正确显示。
 *
 * 用法：
 *   node --no-warnings src/daily-digest.ts --days=1                    # 只生成文件
 *   node --no-warnings src/daily-digest.ts --days=1 --send             # 生成并推送
 *   node --no-warnings src/daily-digest.ts --days=7 --out=output/d.md  # 补看一周
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const DAYS = Number(argOf('days') ?? 1);
const SEND = process.argv.includes('--send');
const AS_JSON = process.argv.includes('--json');
const OUT = argOf('out') ?? 'output/digest.md';
const CFG_PATH = argOf('config') ?? 'data/notify.config.json';

/**
 * 本地日期（Asia/Shanghai）。
 *
 * 为什么不用 toISOString()：它是 UTC。定时任务 06:00 跑时 UTC 还是前一天 22:00，
 * 于是「近 2 天」实际变成 2.5 天、日报标题显示成昨天，剩余天数整体错一天。
 */
const todayOf = (ms = Date.now()): string =>
  new Date(ms - new Date(ms).getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

interface Item {
  guid: string;
  city: string;
  pubDate: string;
  title: string;
  tag: string;
  url: string;
  amount: number | null;
  days: number | null;
}

const TAG_CN: Record<string, string> = {
  pv: '光伏',
  storage: '储能',
  power: '电力',
  building: '房建',
};

// ---------------- 取数 ----------------
const db = new DatabaseSync(join('data', 'index.db'), { readOnly: true });
const today = todayOf();
const since = todayOf(Date.now() - DAYS * 864e5);

// 限价与工期可能一对多（多标段），用子查询取最大值，避免 JOIN 放大行数
const rows = db
  .prepare(
    `SELECT a.guid, a.city, a.pub_date AS pubDate, a.title,
            a.primary_tag AS tag, a.origin_url AS url,
            (SELECT MAX(amount) FROM tender_control_price WHERE announcement_guid = a.guid) AS amount,
            (SELECT MAX(days)   FROM tender_duration      WHERE announcement_guid = a.guid) AS days
     FROM announcement a
     WHERE a.bulletin_nature = '1' AND a.pub_date >= ?
     ORDER BY a.pub_date DESC, a.city`,
  )
  .all(since) as unknown as Item[];

// --json 专用：截止时间 / 已下载附件 / 紧急区。
// 只在 --json 时查，Markdown 与推送路径完全不碰这几张表 ——
// text 是文件与推送共用的同一个变量，动主 SQL 就会动推送内容，那是另一份风险预算。
const deadlineMap = new Map<
  string,
  { date: string | null; hhmm: string | null; source: string | null; confidence: string | null }
>();
const attachSet = new Set<string>();
type UrgentRow = {
  guid: string;
  title: string;
  city: string | null;
  tag: string | null;
  url: string | null;
  pubDate: string;
  date: string;
  hhmm: string | null;
  confidence: string;
};
let urgentRows: UrgentRow[] = [];

if (AS_JSON) {
  const ids = rows.map((r) => r.guid);
  // SQLite 单条语句参数上限 999，按 500 分批
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const ph = part.map(() => '?').join(',');

    const ds = db
      .prepare(
        `SELECT announcement_guid g, deadline_date date, hhmm, source, confidence
         FROM announcement_deadline WHERE announcement_guid IN (${ph})`,
      )
      .all(...part) as unknown as Array<{
      g: string;
      date: string | null;
      hhmm: string | null;
      source: string | null;
      confidence: string | null;
    }>;
    for (const d of ds) {
      deadlineMap.set(d.g, { date: d.date, hhmm: d.hhmm, source: d.source, confidence: d.confidence });
    }

    // 附件真值在 announcement_attachment（attachment.announcement_guid 只记首次写入者）
    const as = db
      .prepare(`SELECT DISTINCT announcement_guid g FROM announcement_attachment WHERE announcement_guid IN (${ph})`)
      .all(...part) as unknown as Array<{ g: string }>;
    for (const a of as) attachSet.add(a.g);
  }

  // 紧急区必须独立查全库：40 天前发布、明天截止的标，在「近 2 天」窗口里根本不存在。
  // 只取 confidence='high' —— 假警报比没警报更伤信任。
  const hi = todayOf(Date.now() + 3 * 864e5);
  urgentRows = db
    .prepare(
      `SELECT a.guid, a.title, a.city, a.primary_tag tag, a.origin_url url, a.pub_date pubDate,
              d.deadline_date date, d.hhmm, d.confidence
       FROM announcement a JOIN announcement_deadline d ON d.announcement_guid = a.guid
       WHERE a.bulletin_nature = '1' AND d.confidence = 'high'
         AND d.deadline_date BETWEEN ? AND ?
       ORDER BY d.deadline_date ASC, d.hhmm ASC LIMIT 50`,
    )
    .all(today, hi) as unknown as UrgentRow[];
}
db.close();

// ---------------- 组装 ----------------
const byTag = new Map<string, Item[]>();
for (const it of rows) {
  const k = TAG_CN[it.tag] ?? '其他';
  const arr = byTag.get(k) ?? [];
  arr.push(it);
  byTag.set(k, arr);
}

const tagSummary = [...byTag.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([k, v]) => `${k} ${v.length}`)
  .join(' / ');

const lines: string[] = [];
lines.push(`安徽招标日报 · ${today}`);
lines.push(
  rows.length
    ? `近 ${DAYS} 天新增 ${rows.length} 条招标公告（${tagSummary}）`
    : `近 ${DAYS} 天没有新增招标公告（数据可能未更新，检查爬虫）`,
);
lines.push('');

const wan = (n: number): string => `${(n / 1e4).toFixed(0)} 万`;

for (const [tag, items] of [...byTag.entries()].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`▍${tag}（${items.length}）`);
  let i = 0;
  for (const it of items) {
    i++;
    const bits = [it.city, it.pubDate];
    if (it.amount) bits.push(`限价 ${wan(it.amount)}`);
    if (it.days) bits.push(`工期 ${it.days} 天`);
    lines.push(`${i}. ${it.title}`);
    lines.push(`   ${bits.join(' · ')}`);
    if (it.url) lines.push(`   ${it.url}`);
    if (i >= 10 && items.length > 10) {
      lines.push(`   …还有 ${items.length - 10} 条`);
      break;
    }
  }
  lines.push('');
}

if (rows.length) {
  lines.push(`共 ${rows.length} 条｜全部明细见 data\\index.db 或面板 http://127.0.0.1:8420/check`);
}

const text = lines.join('\n');

// --json：给面板用。Markdown 的 text 已经在上面组装完，这里只加字段、不改已有内容。
if (AS_JSON) {
  const daysLeftOf = (d: string | null): number | null => {
    if (!d) return null;
    return Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
  };

  const items = rows.map((it) => {
    const d = deadlineMap.get(it.guid);
    return {
      guid: it.guid,
      title: it.title,
      city: it.city,
      pubDate: it.pubDate,
      tag: it.tag,
      amount: it.amount,
      days: it.days,
      url: it.url,
      deadlineDate: d?.date ?? null,
      hhmm: d?.hhmm ?? null,
      dlSource: d?.source ?? null,
      dlConf: d?.confidence ?? null,
      daysLeft: daysLeftOf(d?.date ?? null),
      hasAttach: attachSet.has(it.guid),
    };
  });

  // 计数基于全量 items，不由前端算 —— 一旦将来截断，前端算出来的计数就是错的
  const counts = {
    due3: items.filter((x) => x.daysLeft !== null && x.daysLeft >= 0 && x.daysLeft <= 3).length,
    due7: items.filter((x) => x.daysLeft !== null && x.daysLeft >= 0 && x.daysLeft <= 7).length,
    noDeadline: items.filter((x) => x.deadlineDate === null).length,
    withAttach: items.filter((x) => x.hasAttach).length,
  };

  // 90 天窗口约 2000 条 / 700KB，本地服务可接受；超过 3000 条才截断并显式标记
  const MAX_ITEMS = 3000;
  const truncated = items.length > MAX_ITEMS;

  // groups 保留：批次 1 的前端切到 items 之前，老结构仍可用
  const groups = [...byTag.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([tag, arr]) => ({
      tag,
      count: arr.length,
      items: arr.slice(0, 200).map((it) => ({
        guid: it.guid,
        title: it.title,
        city: it.city,
        pubDate: it.pubDate,
        amount: it.amount,
        days: it.days,
        url: it.url,
      })),
    }));

  console.log(
    JSON.stringify(
      {
        date: today,
        days: DAYS,
        total: rows.length,
        counts,
        urgent: urgentRows,
        items: truncated ? items.slice(0, MAX_ITEMS) : items,
        truncated,
        groups,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// ---------------- 落盘 ----------------
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text, 'utf8');
console.log(`已生成：${OUT}（${rows.length} 条）`);

// ---------------- 推送 ----------------
interface NotifyConfig {
  wecom?: { webhook?: string };
  smtp?: { host?: string; port?: number; user?: string; pass?: string; to?: string };
}

function loadConfig(): NotifyConfig {
  if (!existsSync(CFG_PATH)) return {};
  try {
    // 必须去 BOM：Windows 记事本 / PowerShell Set-Content 默认写 UTF-8 BOM，
    // 带 BOM 的字符串 JSON.parse 会直接抛 "Unexpected token"。
    const raw = readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as NotifyConfig;
  } catch (e) {
    console.error(`[推送] 配置解析失败（${(e as Error).message}）：${CFG_PATH}，本次只写文件`);
    return {};
  }
}

/** 企业微信 markdown 单条上限 4096 字节，超了要分条，否则直接丢消息 */
function splitByBytes(s: string, limit = 3800): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of s.split('\n')) {
    const next = cur ? `${cur}\n${line}` : line;
    if (Buffer.byteLength(next, 'utf8') > limit) {
      if (cur) out.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function sendWecom(webhook: string, body: string): Promise<void> {
  for (const part of splitByBytes(body)) {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: part } }),
    });
    const j = (await r.json()) as { errcode?: number; errmsg?: string };
    if (j.errcode !== 0) throw new Error(`企业微信返回 errcode=${j.errcode} ${j.errmsg ?? ''}`);
  }
}

async function sendMail(cfg: NonNullable<NotifyConfig['smtp']>, body: string): Promise<void> {
  // 用 Python smtplib：Node 没有内置 SMTP，装依赖违背零依赖约定
  const { execFileSync } = await import('node:child_process');
  execFileSync('python', ['src/send-mail.py', '--subject', `安徽招标日报 ${today}`, '--to', cfg.to ?? ''], {
    input: body,
    encoding: 'utf8',
    env: {
      ...process.env,
      SMTP_HOST: cfg.host ?? '',
      SMTP_PORT: String(cfg.port ?? 465),
      SMTP_USER: cfg.user ?? '',
      SMTP_PASS: cfg.pass ?? '',
    },
  });
}

if (!SEND) {
  console.log('（未加 --send，跳过推送）');
  process.exit(0);
}

const cfg = loadConfig();
const sent: string[] = [];
try {
  if (cfg.wecom?.webhook) {
    await sendWecom(cfg.wecom.webhook, text);
    sent.push('企业微信');
  }
  if (cfg.smtp?.host && cfg.smtp.to) {
    await sendMail(cfg.smtp, text);
    sent.push('邮件');
  }
} catch (e) {
  console.error(`[推送失败] ${(e as Error).message}`);
  process.exit(1);
}

if (sent.length === 0) {
  console.log(`未配置推送渠道（${CFG_PATH} 不存在或缺 wecom/smtp），本次只写文件`);
} else {
  console.log(`已推送：${sent.join('、')}`);
}
