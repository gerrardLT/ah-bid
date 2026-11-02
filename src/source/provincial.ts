/**
 * 安徽省公共资源交易监管网（省级平台）索引解析。
 *
 * 该平台是最省事的入口：一个站点就汇总了全省 16 个地市的公告，
 * 且省级 guid 与各地市站点自身的 infoid 是同一个值，
 * 所以可以"省级平台做索引、原站点做附件"，两边用同一个主键对齐。
 *
 * 实测：该平台只提供公告正文，不含招标文件附件；
 * 正文里的"原文链接"是回到各地市站点的唯一线索。
 */

import { SITE, PROJECT_TYPES } from '../config.ts';
import { request } from '../fetch/http.ts';

export interface ListItem {
  guid: string;
  tenderProjectType: string;
  bulletinNature: string;
  /** 原始形态："亳州市-市辖区-招标公告" */
  area: string;
  city: string;
  district: string;
  title: string;
  pubDate: string;
  /** 中文项目类型，来自 URL 参数而不是猜测 */
  projectType: string;
  natureLabel: string;
}

export interface Detail {
  html: string;
  text: string;
  originUrl: string | null;
  bytes: number;
  /** 实际生效的 type 参数，便于后续固化为常量 */
  usedType: string;
}

export interface ListParams {
  tenderProjectType: string;
  bulletinNature: string;
  page: number;
}

const GUID_RE = /guid=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;

/**
 * 合法日期：月份 01-12、日 01-31。
 *
 * 不能只写 \d{4}-\d{2}-\d{2}：标题里的项目编号（如 JG2026-32-0579）
 * 也包含“2026-32-05”这种字串，会被当成发布日期入库。
 * 实测 3 条省立医院公告的 pub_date 因此变成 2026-32-05，
 * 导致 max(pub_date) 返回错误值、按月统计多出一个“2026-32”月份。
 */
const DATE_RE = /(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))/;

/** 解析列表页。每页 10 条，结构与字段已实测确认。 */
export async function fetchListPage(p: ListParams): Promise<ListItem[]> {
  return (await fetchListPageMeta(p)).items;
}

export interface ListPage {
  items: ListItem[];
  /** 总页数，从页面底部"共 N 页"提取；拿不到时为 0 */
  totalPages: number;
}

export async function fetchListPageMeta(p: ListParams): Promise<ListPage> {
  const qs = new URLSearchParams({
    tenderProjectType: p.tenderProjectType,
    bulletinNature: p.bulletinNature,
    currentPage: String(p.page),
  });
  const res = await request(`${SITE.base}${SITE.listPath}?${qs}`, {
    referer: `${SITE.base}${SITE.listPath}`,
  });

  return {
    items: parseListHtml(res.text),
    totalPages: extractTotalPages(res.text),
  };
}

/** 页面底部有"共 2300 页，当前为第 1 页"。 */
export function extractTotalPages(html: string): number {
  const m = /共\s*(\d+)\s*页/u.exec(html);
  return m ? Number(m[1]) : 0;
}

export function parseListHtml(html: string): ListItem[] {
  const out: ListItem[] = [];
  const blocks = html.match(/<li class="list-item">[\s\S]*?<\/li>/g) ?? [];

  for (const block of blocks) {
    const guidMatch = GUID_RE.exec(block);
    if (!guidMatch) continue;

    const titleMatch = /class="title[^"]*"\s+title="([^"]*)"/.exec(block);
    const areaMatch = /class="area[^"]*">【([^】]+)】/.exec(block);
    const dateMatch = DATE_RE.exec(block);
    const typeMatch = /tenderProjectType=(\w+)/.exec(block);
    const natureMatch = /bulletinNature=(\w+)/.exec(block);

    if (!titleMatch || !areaMatch) continue;

    const area = areaMatch[1].trim();
    // area 形如 "亳州市-市辖区-招标公告"，按 "-" 拆成 市/区县/公告类型
    const parts = area.split('-');

    out.push({
      guid: guidMatch[1],
      tenderProjectType: typeMatch?.[1] ?? '',
      bulletinNature: natureMatch?.[1] ?? '',
      area,
      city: parts[0] ?? '',
      district: parts[1] ?? '',
      title: titleMatch[1].trim(),
      pubDate: dateMatch?.[1] ?? '',
      projectType: PROJECT_TYPES[typeMatch?.[1] ?? ''] ?? '',
      natureLabel: parts.at(-1) ?? '',
    });
  }

  return out;
}

/**
 * 详情正文的 type 参数随公告性质变化。实测结果（基于 8188 条招标 + 93 条候选人）：
 *   招标公告(1)    → tender
 *   中标候选人(2)  → tender（试 zbjg 会返回空壳，白花一次请求）
 *   中标结果(3)    → zbjg
 * 候选按"首选 + 回退"排列：首选命中就只发一次请求。
 * 之前把 zbjg 放在候选人首位，导致每条多一次无效请求，速度直接减半。
 */
const DETAIL_TYPE_CANDIDATES: Record<string, string[]> = {
  '1': ['tender'],
  '2': ['tender', 'zbjg'],
  '3': ['zbjg', 'zbtzs', 'tender'],
};

const MIN_VALID_DETAIL_BYTES = 2000;

export async function fetchDetail(item: ListItem): Promise<Detail> {
  const candidates = DETAIL_TYPE_CANDIDATES[item.bulletinNature] ?? ['tender'];
  const referer = `${SITE.base}/jsgc/newDetail?guid=${item.guid}&tenderProjectType=${item.tenderProjectType}&bulletinNature=${item.bulletinNature}`;

  let bestFallback: Detail | null = null;

  for (const type of candidates) {
    const body = new URLSearchParams({
      type,
      bulletinNature: item.bulletinNature,
      guid: item.guid,
      statusGuid: '',
    }).toString();

    const res = await request(`${SITE.base}${SITE.detailPath}`, {
      method: 'POST',
      body,
      referer,
    });

    const detail: Detail = {
      html: res.text,
      text: htmlToText(res.text),
      originUrl: extractOriginUrl(res.text),
      bytes: res.bytes,
      usedType: type,
    };

    if (res.bytes >= MIN_VALID_DETAIL_BYTES) return detail;
    // 记录第一个非空但偏小的结果，全部候选都失败时返回它，避免丢数据
    if (!bestFallback && res.bytes > 200) bestFallback = detail;
  }

  return (
    bestFallback ?? {
      html: '',
      text: '',
      originUrl: null,
      bytes: 0,
      usedType: candidates[0],
    }
  );
}

/**
 * 正文里的"原文链接"。各地市跳转页写法不一
 * （tiaozhuan.html / jump.html / redirect.html / pageRedirectAction.action），
 * 但都带 infoid 或 attachGuid 线索，所以按特征匹配而不是按域名。
 */
export function extractOriginUrl(html: string): string | null {
  const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  if (links.length === 0) return null;

  const strong = links.find((u) =>
    /tiaozhuan|jump\.html|redirect\.html|pageredirect|pageRedirect/i.test(u),
  );
  if (strong) return strong;

  const withInfoid = links.find((u) => /infoid=/i.test(u));
  if (withInfoid) return withInfoid;

  return null;
}

/** HTML 转纯文本。正文里的 &nbsp; 极多，统一压成单个空格。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
}
