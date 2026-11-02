/**
 * HTTP 抓取层。
 *
 * 实测约束（2026-10 验证）：
 * - 该站不带 Referer 或请求过快时，会返回约 1484 字节的错误页而非真实内容，
 *   因此这里统一做串行限速 + 重试。
 * - 同一接口的响应编码不统一（列表页 UTF-8，部分正文片段为 GBK），
 *   所以解码时必须按内容探测，不能假定 UTF-8。
 */

import { CRAWL } from '../config.ts';

export interface FetchResult {
  status: number;
  finalUrl: string;
  text: string;
  bytes: number;
  /** 仅当请求时传了 binary:true 才有，保存文件必须用它，不能用 text */
  buffer?: Uint8Array;
  /** 未跟随重定向时的 Location 头 */
  location?: string;
}

let lastRequestAt = 0;

/**
 * 二进制响应只解前这么多字节成 text。
 *
 * 下载附件时上层只需要 text 来判断服务端返回的 JSON 错误页（几百字节），
 * 而整段二进制解成字符串会让 V8 直接 `Fatal JavaScript invalid size error` 中止进程
 * ——JS 的 try/catch 拦不住，实测 139MB 附件就死在这里。
 */
const BINARY_TEXT_CAP = 1024 * 1024;

/** 编码探测只看前缀的字节数：整段扫描的成本随体积线性增长，而前缀足以判定编码。 */
const DECODE_PROBE_BYTES = 64 * 1024;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 全局串行限速：保证任意两次请求之间至少 CRAWL.delayMs。 */
async function throttle(): Promise<void> {
  const wait = CRAWL.delayMs - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/**
 * 按内容探测编码。GBK 文本被当作 UTF-8 解码会产生大量替换字符，
 * 用替换字符占比判断，比看 meta charset 更可靠（部分响应没有 meta）。
 *
 * 阈值不能太低：页面主体是 UTF-8 但夹了少量残留字节时，仍会产生个别替换字符，
 * 过于敏感会把 UTF-8 误判成 GBK，解出来全变成「鎷涙爣」这类乱码。
 * 真正的 GBK 页面整体中文全不可解，坏字符占比通常在 30% 以上。
 *
 * 探测只对前缀做：整段 `match(/\uFFFD/g)` 会为巨大响应构造同样巨大的匹配结果数组，
 * 与整段解码叠加就是大附件触发 V8 字符串上限的放大器。前缀占比与整段一致。
 * 前缀截断最多在末尾多产生 1 个替换字符，由 bad > 20 的绝对下限吸收。
 */
export function decode(buf: Uint8Array): string {
  const probe = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, DECODE_PROBE_BYTES));
  const bad = (probe.match(/\uFFFD/g) || []).length;
  if (bad > 20 && bad / Math.max(probe.length, 1) > 0.02) {
    return new TextDecoder('gbk').decode(buf);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: string;
  referer?: string;
  /** 关闭限速，仅用于首次探测连通性。 */
  skipThrottle?: boolean;
  /**
   * 返回原始字节。下载二进制文件（PDF/压缩包）必须开，
   * 否则经过 text 解码后字节会被破坏。
   */
  binary?: boolean;
  /** 超时覆盖，大文件下载需要更长时间 */
  timeoutMs?: number;
  /** 是否自动跟随重定向，默认 true。 */
  followRedirect?: boolean;
  /** 额外请求头（如站点要求的 Authorization） */
  extraHeaders?: Record<string, string>;
}

export async function request(url: string, opts: RequestOptions = {}): Promise<FetchResult> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= CRAWL.retries; attempt++) {
    if (attempt > 0) {
      await sleep(CRAWL.retryBackoffMs * attempt);
    }
    if (!opts.skipThrottle) await throttle();

    try {
      const headers: Record<string, string> = {
        'User-Agent': CRAWL.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      };
      if (opts.referer) headers.Referer = opts.referer;
      if (opts.method === 'POST') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);

      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body,
        redirect: opts.followRedirect === false ? 'manual' : 'follow',
        signal: AbortSignal.timeout(opts.timeoutMs ?? CRAWL.timeoutMs),
      });

      // Buffer.from(ArrayBuffer) 共享底层内存，而 new Uint8Array(ArrayBuffer) 会整份复制：
      // 百 MB 级附件能省掉一次等量拷贝。
      const buf = Buffer.from(await res.arrayBuffer());

      // 5xx 视为可重试；4xx 直接返回给上层判断，不空转。
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }

      return {
        status: res.status,
        finalUrl: res.url,
        // 二进制响应绝不能整段解成文本，只解错误页探测用的头部。
        text: decode(buf.subarray(0, opts.binary ? BINARY_TEXT_CAP : buf.length)),
        bytes: buf.byteLength,
        buffer: opts.binary ? buf : undefined,
        location: res.headers.get('location') ?? undefined,
      };
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(`请求失败（已重试 ${CRAWL.retries} 次）：${url} :: ${String(lastErr)}`);
}
