/**
 * 等待当前下载任务结束后，自动处理省级（城市字段为「安徽省」）的公告。
 *
 * 省级公告的 origin_url 指向各地市站点，适配器是按域名匹配的，
 * 所以跑一次就能把已经攻破的站点覆盖到。
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const LOG = 'data/attach-provincial.log';
const SAMPLE_MS = 60_000;
const STABLE_TARGET = 3;

function log(msg: string): void {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  appendFileSync(LOG, line, 'utf8');
  process.stdout.write(line);
}

/** 当前已下载附件总数（用来判断是否还在增长） */
function attachCount(): number {
  const db = new DatabaseSync('data/index.db');
  try {
    return (db.prepare("SELECT COUNT(*) n FROM attachment WHERE status='ok'").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  log('=== 省级批量任务已排队，等待当前下载结束 ===');

  let prev = -1;
  let stable = 0;
  for (;;) {
    const n = attachCount();
    if (n === prev) {
      stable++;
      if (stable >= STABLE_TARGET) {
        log(`附件数连续 ${stable} 次无增长（${n}），判定当前任务结束`);
        break;
      }
    } else {
      stable = 0;
      log(`当前附件 ${n}，仍在增长`);
    }
    prev = n;
    await sleep(SAMPLE_MS);
  }

  log('\n──── 开始处理省级公告（city=安徽省）────');
  const before = attachCount();

  await new Promise<void>((resolve) => {
    const child = spawn('node', ['--no-warnings', 'src/attach.ts', '--city=安徽省', '--limit=600'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => appendFileSync(LOG, d));
    child.stderr?.on('data', (d: Buffer) => appendFileSync(LOG, d));
    child.on('close', resolve);
  });

  const after = attachCount();
  log(`省级处理完成：附件 ${before} → ${after}（+${after - before}）`);
}

main().catch((e) => {
  log(`异常：${String(e)}`);
  process.exit(1);
});
