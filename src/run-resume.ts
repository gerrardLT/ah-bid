/**
 * 从断点续跑附件下载。
 *
 * 为什么需要它，而不是手敲命令行：
 * 1. 大附件曾触发 V8 `Fatal JavaScript invalid size error` 直接杀进程（见 fetch/http.ts），
 *    崩在中途时既不打印汇总，也不写 failed 记录，必须能从断点接上。
 * 2. 城市名是中文，PowerShell 传参常被重编码成乱码，`--city=` 会变成查不到任何行的静默失败。
 *    参数写死在源码里由 Node 以 UTF-8 读出，绕开这层风险。
 * 3. SQLite 写锁排他，多个实例同时跑会 database is locked，所以这里严格串行，
 *    并在启动前确认没有别的 attach.ts 在写库。
 *
 * 用法：node --no-warnings src/run-resume.ts
 * 改目标：编辑下面的 JOBS（before 是 pub_date 上界，含当天）。
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const LOG = 'data/attach-resume.log';

interface Job {
  city: string;
  /** 公告性质，默认 '1'（招标公告）；2=中标候选人公示，3=中标结果公告 */
  nature?: string;
  /** pub_date 上界（YYYY-MM-DD，含），断点日期取上次日志最后一条公告的发布日期 */
  before?: string;
  limit: number;
  /** 日志文件名，便于事后区分批次 */
  tag: string;
  /** 只重试 status='failed' 的附件（此模式下 before 不生效） */
  retry?: boolean;
  /** 只处理库里零附件记录的公告（补覆盖漏洞） */
  onlyMissing?: boolean;
  /** 只下载文件名匹配这个正则的附件（定向抓取高价值文件） */
  nameMatch?: string;
}

/**
 * 当前批次：中标公告的定向抓取（只下高价值文件）。
 * 先跑宿州+淮北两个高产出站做命中率测试，再决定是否放大。
 */
const HIGH_VALUE =
  '交易见证书|评标情况|评审情况|评标结果|中标通知书|成交通知书|合同|协议|中标候选人信息|补疑|澄清|变更|控制价|工程量清单';
const JOBS: Job[] = [
  { city: '宿州市', nature: '3', limit: 60, tag: 'award-sz', nameMatch: HIGH_VALUE },
  { city: '淮北市', nature: '3', limit: 60, tag: 'award-hb', nameMatch: HIGH_VALUE },
];

function log(msg: string): void {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  appendFileSync(LOG, line, 'utf8');
  process.stdout.write(line);
}

function attachOkCount(): number {
  const db = new DatabaseSync('data/index.db', { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) n FROM attachment WHERE status='ok'").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** 启动前确认没有并发写库的实例：WAL 只支持一写，busy_timeout 只是兜底。 */
function assertNoWriter(): void {
  const db = new DatabaseSync('data/index.db');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
  } catch (e) {
    throw new Error(`index.db 已被其它进程占用，不能并发启动：${String(e)}`);
  } finally {
    db.close();
  }
}

async function runJob(job: Job): Promise<void> {
  const before = attachOkCount();
  const nature = job.nature ?? '1';
  const mode =
    [
      job.retry ? '--retry-failed' : '',
      job.before ? `--before=${job.before}` : '',
      job.onlyMissing ? '--only-missing' : '',
      job.nameMatch ? '--name-match=<正则>' : '',
    ]
      .filter(Boolean)
      .join(' ') || '全量';
  log(`──── ${job.city} 性质${nature} 开始（${mode} --limit=${job.limit}）当前 ok=${before} ────`);

  const out = `data/attach-${job.tag}.log`;
  const err = `data/attach-${job.tag}.err`;

  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(
      'node',
      [
        '--no-warnings',
        'src/attach.ts',
        `--city=${job.city}`,
        `--nature=${job.nature ?? '1'}`,
        ...(job.retry ? ['--retry-failed'] : job.before ? [`--before=${job.before}`] : []),
        ...(job.onlyMissing ? ['--only-missing'] : []),
        ...(job.nameMatch ? [`--name-match=${job.nameMatch}`] : []),
        `--limit=${job.limit}`,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // 子进程输出按原始字节落盘，避免任何一层重编码把中文变乱码。
    child.stdout?.on('data', (d: Buffer) => appendFileSync(out, d));
    child.stderr?.on('data', (d: Buffer) => appendFileSync(err, d));
    child.on('error', (e) => {
      log(`spawn 失败：${String(e)}`);
      resolve(null);
    });
    child.on('close', resolve);
  });

  const after = attachOkCount();
  // 0x80000003（有符号 -2147483645）= V8 硬中止，不是业务失败，必须显式喊出来。
  const fatal = code !== null && (code >>> 0) === 0x80000003;
  log(
    `──── ${job.city} 结束 code=${code} ok ${before} → ${after}（+${after - before}）` +
      `${fatal ? ' ⚠ V8 硬中止，见 ' + err : code === 0 ? '' : ' ⚠ 非正常退出，见 ' + err}` +
      ` ────`,
  );
}

async function main(): Promise<void> {
  assertNoWriter();
  log('=== 断点续跑开始 ===');
  for (const job of JOBS) await runJob(job);
  log('\n=== 全部批次结束 ===');
}

main().catch((e) => {
  log(`异常：${String(e)}`);
  process.exit(1);
});
