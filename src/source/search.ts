/**
 * 省级平台站内全文搜索。
 *
 * 用途与限制（实测）：
 * - 支持全文检索 + 分页，能直接定位"光伏""储能"这类业务词，非常适合做召回验证。
 * - 但结果是**全历史、按相关度排序**（同一页里会混着 2017 和 2026 年的公告），
 *   不能靠"翻到旧年份就停"来限定时间范围，也不能替代列表页做时间切片。
 */

import { SITE } from '../config.ts';
import { request } from '../fetch/http.ts';

export interface SearchHit {
  guid: string;
  title: string;
  /** 站内相对路径，可能是 /jsgc /qtjy /jgAdminSupervise 等不同栏目 */
  href: string;
  /** 交易信息 / 监管信息 等 */
  section: string;
  date: string;
  /** 结果里带的原始分类码，如 A08、A99，仅供交叉参考 */
  projectTypeParam: string;
  natureParam: string;
}

const GUID_RE = /guid=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;

export async function searchAnnouncements(param: string, page = 1): Promise<SearchHit[]> {
  const res = await request(`${SITE.base}${SITE.searchPath}`, {
    method: 'POST',
    body: new URLSearchParams({ param, currentPage: String(page) }).toString(),
    referer: `${SITE.base}/jsgc/list`,
  });

  return parseSearchHtml(res.text);
}

export function parseSearchHtml(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const blocks = html.split('<div class="search_left_content">').slice(1);

  for (const block of blocks) {
    const guidMatch = GUID_RE.exec(block);
    const hrefMatch = /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!guidMatch || !hrefMatch) continue;

    const sectionMatch = /class="search_left_xx"[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const dateMatch = /<p class="search_link">[\s\S]*?<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/.exec(block);
    const typeMatch = /tenderProjectType=(\w+)/.exec(hrefMatch[1]);
    const natureMatch = /bulletinNature=(\w+)/.exec(hrefMatch[1]);

    out.push({
      guid: guidMatch[1],
      // 标题里有 <font color='red'> 高亮，先剥标签再压缩空白
      title: stripTags(hrefMatch[2]).replace(/\s+/g, ' ').trim(),
      href: hrefMatch[1],
      section: sectionMatch ? stripTags(sectionMatch[1]).trim() : '',
      date: dateMatch?.[1] ?? '',
      projectTypeParam: typeMatch?.[1] ?? '',
      natureParam: natureMatch?.[1] ?? '',
    });
  }

  return out;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}
