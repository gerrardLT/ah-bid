/**
 * 住建系统标准化图册批量下载器。
 *
 * 为什么要单独写：这类图册单个 70–700 MB，普通 curl 一次下不完，
 * 断了就得从头来。这里用 .part 文件 + Range 续传，断了重跑接着下。
 *
 * 用法：
 *   node src/atlas.ts              # 下载全部未完成的
 *   node src/atlas.ts --force      # 强制重下
 *   node src/atlas.ts --list       # 只列清单
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0';
const OUT_DIR = 'data/atlas';
/** 小于这个体积的基本都是转发通知，不是图册本体 */
const MIN_VALID_MB = 20;

interface AtlasSource {
  id: string;
  name: string;
  url: string;
  referer: string;
  /** 已知页数，用于下载后核对（0 表示未知） */
  pages: number;
  note?: string;
}

/**
 * 来源清单。全部为政府机关主动公开的 PDF 直链。
 * expectMinMB 用于识别"下下来其实是通知文件"的情况。
 */
const SOURCES: AtlasSource[] = [
  {
    id: 'hubei-2019',
    name: '房屋市政工程安全生产标准化指导图册（湖北省住建厅转载）',
    url: 'http://zjt.hubei.gov.cn/bmdt/ztzl/aqsc/qydp/202006/P020200603617117328552.pdf',
    referer: 'http://zjt.hubei.gov.cn/bmdt/ztzl/aqsc/qydp/202006/t20200603_2377627.shtml',
    pages: 260,
    note: '已验证：260 页，每页一张 JPEG，2022 版',
  },
  {
    id: 'wuhan-2024',
    name: '武汉市房屋市政工程安全文明施工标准化指导图册（2024版）',
    url: 'https://zgj.wuhan.gov.cn/zwdt/tzgg/202502/P020250211409434019258.pdf',
    referer: 'https://zgj.wuhan.gov.cn/zwdt/tzgg/202502/t20250211_2531270.shtml',
    pages: 0,
    note: '约 678 MB，分辨率高于湖北版，需续传',
  },
  {
    id: 'liuzhou-notice',
    name: '（反例）柳州市转发的建办质函〔2019〕90 号通知',
    url: 'http://zjj.liuzhou.gov.cn/zwgk/fdzdgknr/zcwj/zcgf/202011/P020201110374585752942.pdf',
    referer: 'http://zjj.liuzhou.gov.cn/',
    pages: 2,
    note: '仅 63 KB，是通知扫描件，保留作大小判据参考',
  },
  {
    id: 'fuzhou-notice',
    name: '（反例）福州市转发的建办质函〔2019〕90 号通知',
    url: 'https://zjj.fuzhou.gov.cn/zwgk/ztzl/aqscbzhzl/201903/P020190328372079751764.pdf',
    referer: 'https://zjj.fuzhou.gov.cn/',
    pages: 2,
    note: '仅 770 KB，同样是通知扫描件',
  },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function log(msg: string): void {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  appendFileSync('data/atlas-download.log', line, 'utf8');
  process.stdout.write(line);
}

/** 用 Range 续传下载。返回落盘路径，失败抛错。 */
async function downloadWithResume(src: AtlasSource): Promise<{ path: string; bytes: number } | 'skip'> {
  mkdirSync(OUT_DIR, { recursive: true });
  const target = join(OUT_DIR, `${src.id}.pdf`);
  const part = join(OUT_DIR, `${src.id}.pdf.part`);

  // 已完整下载过
  if (existsSync(target)) {
    const size = statSync(target).size;
    if (size > MIN_VALID_MB * 1024 * 1024) {
      return { path: target, bytes: size };
    }
    log(`  已有文件仅 ${(size / 1048576).toFixed(1)} MB，判定不完整，重新下载`);
    unlinkSync(target);
  }

  let start = existsSync(part) ? statSync(part).size : 0;
  if (start > 0) log(`  发现未完成文件 ${(start / 1048576).toFixed(1)} MB，从断点续传`);

  const headers: Record<string, string> = { 'User-Agent': UA, Referer: src.referer };
  if (start > 0) headers.Range = `bytes=${start}-`;

  const res = await fetch(src.url, { headers });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status}`);
  }

  const totalHeader = res.headers.get('content-range');
  const total = totalHeader ? Number(/\/(\d+)$/.exec(totalHeader)?.[1] ?? 0) : Number(res.headers.get('content-length') ?? 0);

  const chunk = Buffer.from(await res.arrayBuffer());

  // 206 = 续传成功；200 = 服务器不支持 Range，只能整份重下
  if (res.status === 206 && start > 0) {
    appendFileSync(part, chunk);
  } else {
    if (start > 0) log(`  服务器不支持断点续传，整份重下`);
    writeFileSync(part, chunk);
    start = 0;
  }

  const nowSize = statSync(part).size;
  if (total > 0 && nowSize < total) {
    throw new Error(`未下完：${(nowSize / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
  }

  renameSync(part, target);
  return { path: target, bytes: nowSize };
}

/** 校验是不是真的 PDF，且超过体积下限。 */
function verify(path: string): { ok: boolean; reason: string; pages: string } {
  const buf = Buffer.alloc(Math.min(1024, statSync(path).size));
  const fd = openSync(path, 'r');
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);

  const sizeMB = statSync(path).size / 1048576;
  if (buf.subarray(0, 4).toString('latin1') !== '%PDF') {
    return { ok: false, reason: '不是 PDF', pages: '-' };
  }
  if (sizeMB < MIN_VALID_MB) {
    return { ok: false, reason: `仅 ${sizeMB.toFixed(1)} MB，疑似通知文件而非图册`, pages: '-' };
  }
  return { ok: true, reason: '正常', pages: `${sizeMB.toFixed(1)} MB` };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes('--list');
  const force = argv.includes('--force');
  const maxRetries = 5;

  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`清单共 ${SOURCES.length} 项\n`);
  for (const s of SOURCES) {
    console.log(`${s.id.padEnd(16)} ${s.name}`);
    console.log(`${' '.repeat(17)}${s.url}`);
    if (s.note) console.log(`${' '.repeat(17)}备注：${s.note}`);
    console.log();
  }
  if (listOnly) return;

  log('=== 开始下载 ===');

  for (const src of SOURCES) {
    log(`\n──── ${src.id} ────`);
    let done = false;

    for (let attempt = 1; attempt <= maxRetries && !done; attempt++) {
      try {
        if (force) {
          const t = join(OUT_DIR, `${src.id}.pdf`);
          if (existsSync(t)) unlinkSync(t);
        }
        const r = await downloadWithResume(src);
        if (r === 'skip') {
          log(`  已存在，跳过`);
          done = true;
          break;
        }
        const v = verify(r.path);
        log(`  ${v.ok ? '✓' : '✗'} ${(r.bytes / 1048576).toFixed(1)} MB  ${v.reason}`);
        done = true;
      } catch (err) {
        log(`  第 ${attempt}/${maxRetries} 次失败：${String(err).slice(0, 100)}`);
        if (attempt < maxRetries) await sleep(3000 * attempt);
      }
    }

    if (!done) log(`  ✗ ${src.id} 多次重试仍失败，下次运行会从断点继续`);
  }

  log('\n=== 完成 ===');
  const files = readdirSync(OUT_DIR).filter((f: string) => f.endsWith('.pdf') || f.endsWith('.part'));
  let total = 0;
  for (const f of files) {
    const size = statSync(join(OUT_DIR, f)).size;
    total += size;
    log(`  ${f.padEnd(24)} ${(size / 1048576).toFixed(1)} MB`);
  }
  log(`  合计 ${(total / 1048576).toFixed(1)} MB`);
}

main().catch((e) => {
  log(`异常：${String(e)}`);
  process.exit(1);
});
