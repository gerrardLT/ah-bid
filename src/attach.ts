/**
 * 附件下载器。
 *
 * 已实证的站点差异：
 * - 蚌埠：详情页可直连，附件是普通 href，下载接口不要验证码 —— 实测拿到 2.7MB PDF。
 * - 阜阳：详情页可直连，但附件下载要验证码，而该站 OAuth 配置指向内网（10.35.82.140），
 *   验证码图根本加载不出来，属站点自身故障。
 * - 合肥/滁州/安庆/宣城/六安：详情页只返回前端跳转壳（几百字节），需另行适配。
 *
 * 本版只处理"能拿到详情页且附件不收验证码"的站点，其余记 skipped 并写明原因，
 * 不做假成功。
 *
 * 用法：
 *   node src/attach.ts --city=蚌埠市 --limit=5 --dry-run     # 只看解析结果
 *   node src/attach.ts --city=蚌埠市 --limit=20                # 实际下载
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { IndexDb } from './db.ts';
import { TAG_LABELS, type Tag } from './config.ts';
import { request } from './fetch/http.ts';
import { declaredExt, headPreview, looksLikeErrorPage, sniff } from './filetype.ts';

interface Args {
  db: string;
  city: string;
  nature: string;
  limit: number;
  dryRun: boolean;
  outRoot: string;
  /** 只处理主类在四类里的公告 */
  tagFilter: string[];
  /** 只重试 attachment 表里 status='failed' 的附件 */
  retryFailed: boolean;
  /** 命令行是否显式给了 --city：补跑模式下用于把重试范围收到单个站点 */
  hasCity: boolean;
  /**
   * 只处理 pub_date <= 该日期（YYYY-MM-DD）的公告。
   * 用于进程崩溃或被中断后从断点续跑：本任务按 pub_date 降序处理，
   * 已跑过的高日期段不必再回源抓一次详情页。
   */
  before: string;
  /** 只处理库里零附件记录的公告，用于补覆盖漏洞（区别于 --retry-failed：那条要求已有失败行） */
  onlyMissing: boolean;
  /**
   * 只下载文件名匹配这个正则的附件（--name-match）。
   * 用于定向抓取：中标公告里 80% 的附件是公告正文的签章版，内容已在 body_text 里，
   * 真正带新信息的是交易见证书、评标情况表、合同这类少数文件。
   */
  nameMatch: string;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, d: string) => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const before = get('before', '');
  // 断点日期必须是完整 ISO 日期：否则字典序截断会静默少跑或多跑一段，比报错更难查。
  if (before && !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    throw new Error(`--before 需要 YYYY-MM-DD 格式，收到「${before}」`);
  }
  const nameMatch = get('name-match', '');
  // 正则写错要当场报，不能默默当“什么都不匹配”而假装跑完。
  if (nameMatch) {
    try {
      new RegExp(nameMatch);
    } catch (e) {
      throw new Error(`--name-match 正则无法编译：${String(e)}`);
    }
  }
  return {
    db: get('db', 'data/index.db'),
    city: get('city', '蚌埠市'),
    nature: get('nature', '1'),
    limit: Number(get('limit', '10')),
    dryRun: argv.includes('--dry-run'),
    outRoot: get('out', 'data/attachments'),
    tagFilter: get('tags', 'power,building,pv,storage').split(',').filter(Boolean),
    retryFailed: argv.includes('--retry-failed'),
    hasCity: argv.some((a) => a.startsWith('--city=')),
    onlyMissing: argv.includes('--only-missing'),
    nameMatch,
    before,
  };
}

/** 文件名安全化：去掉 Windows 非法字符，限长。 */
function safeFilename(name: string, fallback: string): string {
  const cleaned = (name || fallback)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
  return cut || fallback;
}

/** Content-Disposition 里的 filename 常是 GBK，按 latin1 取出后重新解码。 */
function filenameFromDisposition(cd: string | null): string {
  if (!cd) return '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* ignore */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  if (!plain) return '';
  const raw = plain[1];
  // latin1 还原字节后用 GBK 解，比直接用乱码字符串强
  try {
    const bytes = Buffer.from(raw, 'latin1');
    const decoded = new TextDecoder('gbk').decode(bytes);
    // 解出来若全是替换字符就退回原文
    return decoded.includes('\uFFFD') ? raw : decoded;
  } catch {
    return raw;
  }
}

interface ParsedAttach {
  href: string;
  filename: string;
}

/**
 * 解析附件。三类来源：
 * - JSON（芜湖）：Data.detail.Files[]，href 是纯 attachGuid
 * - onclick="ztbfjyz('<url>', ...)"（阜阳/马鞍山/宿州）
 * - 普通 <a href="...downloadZtbAttach...">（蚌埠/合肥/黄山）
 */
function parseAttachments(text: string): ParsedAttach[] {
  const found: ParsedAttach[] = [];
  const seen = new Set<string>();

  const push = (href: string, filename: string) => {
    if (!href) return;
    const key = /attachGuid=([0-9a-zA-Z-]{15,})/i.exec(href)?.[1] ?? href;
    if (seen.has(key)) return;
    seen.add(key);
    const clean = filename
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    found.push({ href, filename: clean });
  };

  // 来源一：JSON（芜湖 SPA）
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(text) as {
        Data?: { detail?: { Files?: Array<{ Url?: string; Name?: string }>; Attachements?: Array<{ Url?: string; Name?: string }> } };
      };
      const det = j.Data?.detail;
      const files = det?.Files ?? det?.Attachements ?? [];
      for (const f of files) {
        if (f?.Url) push(f.Url, f.Name ?? '');
      }
      return found;
    } catch {
      /* 不是合法 JSON，继续按 HTML 解 */
    }
  }

  // 结构一：onclick 包裹，文件名在 title 属性或 file-name 子节点或链接文本
  // 必须从 <a 开始匹配：若从 onclick 开始，后续去标签时会漏掉 onclick 本身，
  // 把属性文本当成文件名。
  for (const m of text.matchAll(/<a\b[^>]*onclick="ztbfjyz\('([^']+)'[\s\S]{0,800}?<\/a>/gi)) {
    const block = m[0];
    const title = /title="([^"]+)"/.exec(block)?.[1] ?? '';
    const fileName = /class="file-name[^"]*"[^>]*>\s*([^<]+)/.exec(block)?.[1] ?? '';
    const anchorText = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? '';
    const text = anchorText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    push(m[1], title || fileName || text);
  }

  // 结构二：普通 a 标签直接挂下载地址
  for (const m of text.matchAll(
    /<a\s[^>]*href="([^"]*download[Zz]tb[Aa]ttach[^"]*)"[^>]*>\s*([^<]*?)\s*<\/a>/gi,
  )) {
    push(m[1], m[2]);
  }

  return found;
}

/** 站点适配：把原文链接换成可直接抓的详情页地址。 */

/** 合肥的 tiaozhuan.html 只是前端跳转壳，必须调接口换真实详情页。 */
async function resolveHefeiDetail(originUrl: string): Promise<string> {
  const infoid = /infoid=([0-9a-f-]{36})/i.exec(originUrl)?.[1] ?? '';
  if (!infoid) throw new Error('合肥原文链接里没有 infoid');
  const categorynum = /categorynum=(\d+)/.exec(originUrl)?.[1] ?? '002002004';

  // 必须走 https：http 会 301 到 https，且 POST 被降级成 GET 导致 405
  const res = await request(
    'https://ggzy.hefei.gov.cn/EpointWebBuilderService/rest/webbuilderserverforHeFZTB/pageredirectnew',
    {
      method: 'POST',
      body: new URLSearchParams({
        infoid,
        siteGuid: '7eb5f7f1-9041-43ad-8e13-8fcb82ea831a',
        categorynum,
      }).toString(),
      referer: originUrl,
    },
  );

  const infoUrl = (JSON.parse(res.text) as { infoUrl?: string }).infoUrl;
  if (!infoUrl) throw new Error('pageredirectnew 未返回 infoUrl');
  return infoUrl.startsWith('http') ? infoUrl : `https://ggzy.hefei.gov.cn${infoUrl}`;
}

/** 这些是交易中心的系统说明文件，每条公告都挂，不是招标文件本体。 */
const NOISE_FILENAME = /操作手册|异议操作|投诉.*手册|用户手册|投标人操作/;

/** 安徽各市站点普遍共用的 siteGuid。 */
const COMMON_SITE_GUID = '7eb5f7f1-9041-43ad-8e13-8fcb82ea831a';

/**
 * 走 pageRedirectAction 的站点：POST 后服务端 302 到真实详情页。
 * 必须用服务端兼容的域名和 projectName，否则会 301 到 https 而 POST 降级成 GET。
 */
interface RedirectRule {
  base: string;
  redirectPath: string;
}

const PAGE_REDIRECT_SITES: Record<string, RedirectRule> = {
  'ggzy.huangshan.gov.cn': {
    base: 'http://ggzy.huangshan.gov.cn',
    redirectPath: '/EpointWebBuilder/pageRedirectAction.action?cmd=pageRedirect',
  },
  'zbcg.mas.gov.cn': {
    base: 'https://zbcg.mas.gov.cn',
    redirectPath: '/EpointWebBuilder_new/pageRedirectAction.action?cmd=pageRedirect',
  },
  // 亳州必须用 https：http 会 301 且把参数拼成 ?cmd=pageRedirect?infoid=...
  'ggzy.bozhou.gov.cn': {
    base: 'https://ggzy.bozhou.gov.cn',
    redirectPath: '/EpointWebBuilder/pageRedirectAction.action?cmd=pageRedirect',
  },
};

/**
 * 通过 pageRedirectAction 换到真实详情页。
 * 关闭自动跟随重定向：该接口是 POST → 302，自动跟随会丢 POST 参数或拿到中间的 JSON，
 * 所以先拿 Location 再单独 GET。
 */
async function resolveByPageRedirect(
  originUrl: string,
  rule: RedirectRule,
): Promise<{ html: string; url: string }> {
  const infoid = /infoid=([0-9a-fA-F-]{36})/.exec(originUrl)?.[1] ?? '';
  if (!infoid) throw new Error('原文链接里没有 infoid');
  const locRaw = /locationurl=([^&]+)/.exec(originUrl)?.[1] ?? '';
  const locationurl = locRaw ? decodeURIComponent(locRaw) : rule.base;

  const res = await request(`${rule.base}${rule.redirectPath}`, {
    method: 'POST',
    body: new URLSearchParams({ locationurl, infoid, siteGuid: COMMON_SITE_GUID }).toString(),
    referer: originUrl,
    followRedirect: false,
  });

  // 情况一：302 + Location
  if (res.location) {
    const target = res.location.startsWith('http')
      ? res.location
      : new URL(res.location, rule.base).toString();
    const detail = await request(target, { referer: originUrl });
    return { html: detail.text, url: detail.finalUrl };
  }

  // 情况二：接口直接返回 JSON，里面带真实地址
  const trimmed = res.text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(res.text) as { status?: { url?: string }; custom?: string | { url?: string } };
      const candidate =
        j.status?.url ?? (typeof j.custom === 'string' ? j.custom : j.custom?.url) ?? '';
      if (candidate.startsWith('http')) {
        const detail = await request(candidate, { referer: originUrl });
        return { html: detail.text, url: detail.finalUrl };
      }
    } catch {
      /* 落到下面当作普通响应 */
    }
  }

  return { html: res.text, url: originUrl };
}

/** 六安：POST getInfoByInfoid，params 是 JSON 字符串，返回 custom.infourl */
async function resolveLuanDetail(originUrl: string): Promise<{ html: string; url: string }> {
  const base = new URL(originUrl).origin;
  const infoid = /infoid=([0-9a-fA-F-]{36})/.exec(originUrl)?.[1] ?? '';
  const res = await request(`${base}/EpointWebBuilder/rest/frontAppCustomAction/getInfoByInfoid`, {
    method: 'POST',
    body: new URLSearchParams({
      params: JSON.stringify({ siteGuid: COMMON_SITE_GUID, infoid }),
    }).toString(),
    referer: originUrl,
  });
  const j = JSON.parse(res.text) as { custom?: { infourl?: string } };
  const rel = j.custom?.infourl ?? '';
  if (!rel) throw new Error('六安 getInfoByInfoid 未返回 infourl');
  const detailUrl = rel.startsWith('http') ? rel : `${base}${rel}`;
  const d = await request(detailUrl, { referer: originUrl });
  return { html: d.text, url: d.finalUrl };
}

/** 宿州：POST getInfoByID，返回 custom.infoUrl。滁州用的是同一个接口。 */
async function resolveGetInfoById(originUrl: string): Promise<{ html: string; url: string }> {
  const base = new URL(originUrl).origin;
  const infoid = /infoid=([0-9a-fA-F-]{36})/.exec(originUrl)?.[1] ?? '';
  const res = await request(`${base}/EpointWebBuilder/rest/frontAppNotNeedLoginAction/getInfoByID`, {
    method: 'POST',
    body: new URLSearchParams({
      params: JSON.stringify({ siteGuid: COMMON_SITE_GUID, infoID: infoid }),
    }).toString(),
    referer: originUrl,
  });
  const j = JSON.parse(res.text) as { custom?: { infoUrl?: string } };
  const rel = j.custom?.infoUrl ?? '';
  if (!rel) throw new Error('宿州 getInfoByID 未返回 infoUrl');
  const detailUrl = rel.startsWith('http') ? rel : `${base}${rel}`;
  const d = await request(detailUrl, { referer: originUrl });
  return { html: d.text, url: d.finalUrl };
}

/**
 * 宣城：GET jyxxSearchAction?cmd=infoUrl。
 * 返回的 custom 是相对路径，前面要拼 vname（/xcspfront），不是 projectName。
 */
async function resolveXuanchengDetail(originUrl: string): Promise<{ html: string; url: string }> {
  const base = new URL(originUrl).origin;
  const infoid = /infoid=([0-9a-fA-F-]{36})/.exec(originUrl)?.[1] ?? '';
  const api = `${base}/EpointWebBuilder/jyxxSearchAction.action?cmd=infoUrl&infoid=${infoid}&siteGuid=${COMMON_SITE_GUID}`;
  const res = await request(api, { referer: originUrl });
  const j = JSON.parse(res.text) as { custom?: string };
  const rel = typeof j.custom === 'string' ? j.custom : '';
  if (!rel) throw new Error('宣城 jyxxSearchAction 未返回路径');
  const detailUrl = `${base}/xcspfront${rel}`;
  const d = await request(detailUrl, { referer: originUrl });
  return { html: d.text, url: d.finalUrl };
}

/**
 * 芜湖：Vue SPA，页面本身没有附件。
 * 先跟随 link/notice 拿 contentinfo 的真实 id，再调 GetNoticeDetail 拿 JSON，
 * 附件在 Data.detail.Files[].{Name, Url}。
 */
async function resolveWuhuDetail(originUrl: string): Promise<{ html: string; url: string }> {
  const r1 = await request(originUrl, { referer: originUrl });
  const contentUrl = r1.finalUrl;
  const cid =
    /[?&]id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(contentUrl)?.[1] ?? '';
  if (!cid) throw new Error('芜湖未拿到 contentinfo id');

  const api = `https://whsggzy.wuhu.gov.cn/whjyzx/api/Home/GetNoticeDetail?id=${cid}`;
  const r2 = await request(api, { referer: contentUrl });
  return { html: r2.text, url: contentUrl };
}

/** 淮北的匿名 token 缓存（有效期较长，避免每条公告都重新申请） */
let huaibeiToken: { token: string; at: number } | null = null;

/**
 * 淮北：getInfoByID 需要 OAuth 匿名令牌（Authorization: Bearer）。
 * 与其他站点不同，这里的 OAuth 配置是正常的（client_id=demoClient），
 * 不像阜阳那样指向内网。
 */
async function resolveHuaibeiDetail(originUrl: string): Promise<{ html: string; url: string }> {
  const base = new URL(originUrl).origin;
  const infoid = /infoid=([0-9a-fA-F-]{36})/i.exec(originUrl)?.[1] ?? '';
  if (!infoid) throw new Error('淮北原文链接里没有 infoid');

  // 取 token，缓存 20 分钟
  if (!huaibeiToken || Date.now() - huaibeiToken.at > 20 * 60 * 1000) {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0';
    const infoRes = await fetch(`${base}/EpointWebBuilder/rest/getOauthInfoAction/getAppInfo`, {
      method: 'POST',
      headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ params: JSON.stringify({}) }).toString(),
    });
    const cookies = (infoRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    await infoRes.text();

    const tokRes = await fetch(`${base}/EpointWebBuilder/rest/getOauthInfoAction/getNoUserAccessToken`, {
      method: 'POST',
      headers: {
        'User-Agent': ua,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookies ? { Cookie: cookies } : {}),
      },
      body: new URLSearchParams({ params: JSON.stringify({}) }).toString(),
    });
    const tokText = await tokRes.text();
    const token = (JSON.parse(tokText) as { custom?: { access_token?: string } }).custom?.access_token ?? '';
    if (!token) throw new Error('淮北未取到 access_token');
    huaibeiToken = { token, at: Date.now() };
  }

  const res = await request(`${base}/EpointWebBuilder/rest/frontAppNotNeedLoginAction/getInfoByID`, {
    method: 'POST',
    body: new URLSearchParams({
      params: JSON.stringify({ siteGuid: COMMON_SITE_GUID, infoID: infoid }),
    }).toString(),
    referer: originUrl,
    extraHeaders: { Authorization: `Bearer ${huaibeiToken.token}` },
  });

  const j = JSON.parse(res.text) as { custom?: { infoUrl?: string } };
  const rel = j.custom?.infoUrl ?? '';
  if (!rel) throw new Error('淮北 getInfoByID 未返回 infoUrl');
  const detailUrl = rel.startsWith('http') ? rel : `${base}${rel}`;
  const d = await request(detailUrl, { referer: originUrl });
  return { html: d.text, url: d.finalUrl };
}

/** 这些站点需要单独调接口换详情页。 */
const API_DETAIL_SITES: Record<
  string,
  (originUrl: string) => Promise<{ html: string; url: string }>
> = {
  'ggzy.luan.gov.cn': resolveLuanDetail,
  'ggzyjy.ahsz.gov.cn': resolveGetInfoById,
  'ggzy.chuzhou.gov.cn': resolveGetInfoById,
  'jy.ggj.huainan.gov.cn': resolveGetInfoById,
  'ggzy.huaibei.gov.cn': resolveHuaibeiDetail,
  'ggzyjy.xuancheng.gov.cn': resolveXuanchengDetail,
  'whsggzy.wuhu.gov.cn': resolveWuhuDetail,
};

type DownloadUrl = string;

/**
 * 把附件 href 换成能直接拿到文件字节的地址。
 * - 合肥 downloadZtbAttach.jspx：直接 GET 就是文件
 * - 阜阳/蚌埠 downloadztbattach：返回自动提交的中转页，需换成下载 action
 */
function toDownloadUrl(href: string, base: string): DownloadUrl {
  // 芜湖：href 是纯 attachGuid。页面给的 FilePre 是内网地址，
  // 但公网域名反向代理了同一路径，换成公网前缀即可。
  if (/^[0-9a-zA-Z-]{15,}$/.test(href) && !href.includes('.')) {
    return (
      'https://whsggzy.wuhu.gov.cn/PSPFrameNew/ahdownattach4webaction.action' +
      `?Token=rfspdownload&cmd=download&attachGuid=${href}`
    );
  }

  const u = new URL(href, base);
  if (/downloadZtbAttach\.jspx/i.test(u.pathname)) return u.toString();

  const params = new URLSearchParams(u.search);
  params.set('cmd', 'getContent');
  const path = u.pathname.replace(/downloadztbattach$/i, 'ztbAttachDownloadAction.action');
  return `${u.origin}${path}?${params.toString()}`;
}

/**
 * 文件类型判定的规则本身在 filetype.ts：
 * 签名长度不固定，必须前缀匹配；大体积 XML（宿州 .SZZF）是招标文件本体而不是错误页。
 * 下载器不能因为「不认识格式」就把已经拿到的字节丢掉。
 */

const args = parseArgs(process.argv.slice(2));
const index = new IndexDb(args.db);
const raw = index.db as unknown as DatabaseSync;

// 补跑模式：只取“有失败附件”的公告，避免重扫全部。
// 可以叠 --city 把重试收到单一站点：失败原因往往是站点级的，全库重跑只会把已知的坏站点再跑一遍。
// 注意：这里只算“哪些附件需要重试”的集合，不限量；--limit 统一只限公告数，
// 否则会出现公告被选中但它的部附件静默不在集合里、既不下载也不计数的假完成。
const failedAttachGuids = args.retryFailed
  ? new Set(
      (raw
        .prepare(
          `SELECT attach_guid AS g FROM attachment WHERE status='failed'`
            + (args.hasCity ? ` AND announcement_guid IN (SELECT guid FROM announcement WHERE city = ?)` : ''),
        )
        .all(...(args.hasCity ? [args.city] : [])) as Array<{ g: string }>).map((r) => r.g),
    )
  : null;

const rows = args.retryFailed
  ? (raw
      .prepare(
        `SELECT DISTINCT a.guid, a.city, a.pub_date AS pubDate, a.title,
                a.primary_tag AS tag, a.origin_url AS originUrl
         FROM attachment t JOIN announcement a ON a.guid = t.announcement_guid
         WHERE t.status = 'failed' AND a.origin_url IS NOT NULL
           ${args.hasCity ? 'AND a.city = ?' : ''}
         ORDER BY a.pub_date DESC LIMIT ?`,
      )
      .all(...(args.hasCity ? [args.city] : []), args.limit) as unknown as Array<{
      guid: string;
      city: string;
      pubDate: string;
      title: string;
      tag: Tag;
      originUrl: string;
    }>)
  : (() => {
      // pub_date 是 'YYYY-MM-DD' 文本，字典序即时间序，可以直接用 <= 截断。
      const bound = args.before ? 'AND pub_date <= ?' : '';
      // 补洞模式：还没记录过任何附件关联的公告。用关联表而不是 attachment.announcement_guid，
      // 因为后者只记首个写入者，兄弟公告会永远显得“零附件”而实际文件已在本地。
      const missing = args.onlyMissing
        ? 'AND NOT EXISTS (SELECT 1 FROM announcement_attachment l WHERE l.announcement_guid = announcement.guid)'
        : '';
      const sql = `SELECT guid, city, pub_date AS pubDate, title, primary_tag AS tag, origin_url AS originUrl
         FROM announcement
         WHERE city = ? AND bulletin_nature = ? AND origin_url IS NOT NULL
           AND primary_tag IN (${args.tagFilter.map(() => '?').join(',')})
           ${bound}
           ${missing}
         ORDER BY pub_date DESC LIMIT ?`;
      return raw
        .prepare(sql)
        .all(
          args.city,
          args.nature,
          ...args.tagFilter,
          ...(args.before ? [args.before] : []),
          args.limit,
        ) as unknown as Array<{
        guid: string;
        city: string;
        pubDate: string;
        title: string;
        tag: Tag;
        originUrl: string;
      }>;
    })();

console.log(
  `待处理公告 ${rows.length} 条（${args.city} / nature=${args.nature}${args.before ? ` / ≤${args.before}` : ''}${args.onlyMissing ? ' / 仅零附件' : ''}）\n`,
);

let okCount = 0;
let skipCount = 0;
let failCount = 0;
/** 附件链接里抽不出 attachGuid 的条数（此前是静默跳过，无法与“本来无附件”区分） */
let noGuidCount = 0;
/** 因 --name-match 过滤而未下载的条数 */
let nameSkippedCount = 0;
const nameFilter = args.nameMatch ? new RegExp(args.nameMatch) : null;

for (const row of rows) {
  console.log(`\n── ${row.title.slice(0, 46)}`);
  console.log(`   ${row.pubDate}  [${TAG_LABELS[row.tag] ?? row.tag}]`);

  // 1. 拿到详情页（不同站点跳转方式不同）
  let detailHtml = '';
  let detailUrl = row.originUrl;
  try {
    const host = new URL(row.originUrl).host;
    const rule = PAGE_REDIRECT_SITES[host];
    const apiResolver = API_DETAIL_SITES[host];

    if (rule) {
      const r = await resolveByPageRedirect(row.originUrl, rule);
      detailHtml = r.html;
      detailUrl = r.url;
    } else if (apiResolver) {
      const r = await apiResolver(row.originUrl);
      detailHtml = r.html;
      detailUrl = r.url;
    } else if (host.includes('ggzy.hefei.gov.cn')) {
      detailUrl = await resolveHefeiDetail(row.originUrl);
      const res = await request(detailUrl, { referer: row.originUrl });
      detailHtml = res.text;
    } else {
      // 蚌埠等：服务端直接 302 或直接返回详情页
      const res = await request(row.originUrl, { referer: row.originUrl });
      detailHtml = res.text;
      detailUrl = res.finalUrl;
    }
  } catch (err) {
    console.log(`   ✗ 详情页失败：${String(err).slice(0, 70)}`);
    failCount++;
    continue;
  }

  if (detailHtml.length < 3000) {
    console.log(`   ✗ 详情页只有 ${detailHtml.length}B（前端跳转壳），本站点需单独适配`);
    skipCount++;
    continue;
  }

  const attaches = parseAttachments(detailHtml);
  console.log(`   详情页 ${detailHtml.length}B，附件 ${attaches.length} 个`);
  if (attaches.length === 0) {
    skipCount++;
    continue;
  }

  for (const a of attaches) {
    if (NOISE_FILENAME.test(a.filename)) {
      console.log(`   · 跳过系统手册：${a.filename.slice(0, 40)}`);
      continue;
    }

    // 定向抓取：文件名不匹配就跳过。日志必须写出来，否则又变成“看起来有附件但库里没有”。
    if (nameFilter && !nameFilter.test(a.filename)) {
      console.log(`   · 跳过（名称不匹配）：${a.filename.slice(0, 40)}`);
      nameSkippedCount++;
      continue;
    }

    // 芜湖的 href 是纯 attachGuid，其余站点在 URL 里带 attachGuid= 参数
    const guidMatch = /attachGuid=([0-9a-zA-Z-]{15,})/i.exec(a.href);
    const attachGuid =
      guidMatch?.[1] ?? (/^[0-9a-zA-Z-]{15,}$/.test(a.href) ? a.href : '');
    if (!attachGuid) {
      // 不能静默跳过：一旦这里悄悄 continue，库里就只留一个“该公告零附件”，
      // 与“本来就没有附件”完全无法区分，事后查不出是解析漏了还是站点变了。
      console.log(`   · 跳过（链接里没 attachGuid）：${a.filename.slice(0, 40)}`);
      noGuidCount++;
      continue;
    }

    // 补跑模式只处理失败过的，避免重复请求已成功的
    if (failedAttachGuids && !failedAttachGuids.has(attachGuid)) continue;

    if (index.hasAttachment(attachGuid)) {
      // 已存在也要记关联：同一批附件会同时挂在多条公告上（省级与地市重发、多标段各自列同一份文件），
      // 只靠 attachment.announcement_guid 的话兄弟公告永远表现为“零附件”。
      index.linkAttachment(row.guid, attachGuid);
      console.log(`   · 已存在，跳过：${a.filename.slice(0, 40)}`);
      continue;
    }

    const dlUrl = toDownloadUrl(a.href, detailUrl);
    if (args.dryRun) {
      console.log(`   · [dry] ${a.filename.slice(0, 46)}`);
      console.log(`         ${dlUrl.slice(0, 120)}`);
      continue;
    }

    try {
      // 必须用 binary，否则 PDF 经过文本解码后会损坏
      const res = await request(dlUrl, {
        referer: detailUrl,
        binary: true,
        timeoutMs: 180000,
      });
      const buf = Buffer.from(res.buffer ?? new Uint8Array());
      const head = buf.subarray(0, 200).toString('utf8').trimStart();

      // 服务端报错时返回 JSON，不是文件
      if (head.startsWith('{')) {
        let reason = head.slice(0, 160);
        try {
          const j = JSON.parse(res.text);
          if (j.custom?.content) reason = String(j.custom.content);
          if (j.custom?.pageVerify === 'true') reason = '需要验证码（站点验证码接口可能已失效）';
        } catch {
          /* ignore */
        }
        index.upsertAttachment({
          attachGuid,
          announcementGuid: row.guid,
          filename: a.filename,
          ext: '',
          sizeBytes: null,
          localPath: null,
          status: 'failed',
          sha256: null,
          reason,
        });
        console.log(`   ✗ ${a.filename.slice(0, 34)} :: ${reason.slice(0, 60)}`);
        failCount++;
        continue;
      }

      const magic = buf.subarray(0, 6).toString('hex').toLowerCase();
      let ext = sniff(buf);
      let note: string | null = null;
      if (!ext) {
        if (looksLikeErrorPage(buf)) {
          const preview = headPreview(buf);
          index.upsertAttachment({
            attachGuid,
            announcementGuid: row.guid,
            filename: a.filename,
            ext: '',
            sizeBytes: buf.length,
            localPath: null,
            status: 'failed',
            sha256: null,
            reason: `站点错误响应/空体 magic=${magic} 体积=${buf.length}B 头部=${preview}`,
          });
          console.log(`   ✗ 错误响应 ${(buf.length / 1024).toFixed(1)}KB ${a.filename.slice(0, 30)}`);
          console.log(`     头部：${preview.slice(0, 110)}`);
          failCount++;
          continue;
        }
        // 签名不在表里、但体积与内容都不是错误页：这就是附件本体，不能因为不认识格式就丢掉。
        // 宿州 .SZZF（根元素 <ZBFile> 的招标文件）与怀远 .18zhzb/.18zhxj 全部落在这一类。
        ext = declaredExt(a.filename);
        note = `签名未识别 magic=${magic}，按文件名声明扩展名保存`;
      }

      const safeName = safeFilename(a.filename, `${attachGuid}${ext}`);
      const ym = row.pubDate.slice(0, 7);
      const relDir = join(TAG_LABELS[row.tag] ?? 'other', ym, row.guid.slice(0, 8));
      const absDir = join(args.outRoot, relDir);
      mkdirSync(absDir, { recursive: true });

      // 落盘路径的归属规则：
      // 1) 这条附件之前已经落过文件（DB 里有 local_path）且还在本目录下 → 直接覆盖自己的文件；
      // 2) 否则占一个不重名的路径。重名后缀用完整 attachGuid 的指纹，
      //    绝不能用前 6 位：站点给的 attachGuid 是递增数字（如 56004839… / 56004883…），
      //    前六位大量相同，会把两份不同附件写到同一路径上互相覆盖，且事后只表现为
      //    字节数与记录不符，极难排查。
      const relPrefix = join('attachments', relDir).replace(/\\/g, '/');
      const prevPath = index.localPathOf(attachGuid);
      let fileName: string;
      let absPath: string;
      if (prevPath && prevPath.startsWith(`${relPrefix}/`)) {
        fileName = prevPath.slice(prevPath.lastIndexOf('/') + 1);
        absPath = join(absDir, fileName);
      } else {
        const dot = safeName.lastIndexOf('.');
        const base = dot > 0 ? safeName.slice(0, dot) : safeName;
        const extPart = dot > 0 ? safeName.slice(dot) : '';
        const stem = createHash('sha1').update(attachGuid).digest('hex').slice(0, 8);
        fileName = safeName;
        absPath = join(absDir, fileName);
        for (let i = 0; existsSync(absPath); i++) {
          fileName = i === 0 ? `${base}_${stem}${extPart}` : `${base}_${stem}-${i}${extPart}`;
          absPath = join(absDir, fileName);
        }
      }
      writeFileSync(absPath, buf);

      const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
      index.upsertAttachment({
        attachGuid,
        announcementGuid: row.guid,
        filename: a.filename,
        ext,
        sizeBytes: buf.length,
        localPath: join('attachments', relDir, fileName).replace(/\\/g, '/'),
        status: 'ok',
        sha256: sha,
        reason: note,
      });
      console.log(`   ✓${note ? '*' : ' '} ${(buf.length / 1024).toFixed(0)} KB  ${fileName.slice(0, 46)}`);
      okCount++;
    } catch (err) {
      index.upsertAttachment({
        attachGuid,
        announcementGuid: row.guid,
        filename: a.filename,
        ext: '',
        sizeBytes: null,
        localPath: null,
        status: 'failed',
        sha256: null,
        reason: String(err).slice(0, 200),
      });
      console.log(`   ✗ 下载异常：${String(err).slice(0, 70)}`);
      failCount++;
    }
  }
}

console.log('\n=== 汇总 ===');
console.log(`成功 ${okCount}  跳过 ${skipCount}（页面结构不支持或已存在）  失败 ${failCount}  无attachGuid ${noGuidCount}  名称不匹配 ${nameSkippedCount}`);
console.log('  带 * 的✓ = 签名未识别、按文件名声明扩展名保存（见 reason）');
for (const s of index.attachmentStats()) {
  console.log(`  附件状态 ${s.status}: ${s.n} 个，${s.mb} MB`);
}
const dir = args.outRoot;
if (existsSync(dir)) {
  console.log(`存储目录：${dir}`);
}
index.close();
