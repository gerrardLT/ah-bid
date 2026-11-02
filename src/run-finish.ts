/**
 * 串行补完剩余城市。
 *
 * 教训：SQLite 写锁排他，多个进程同时写会抛 database is locked。
 * 已在 db.ts 加了 busy_timeout=30s，但根本上还是应该串行跑。
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const LOG = 'data/attach-finish.log';
const CITIES = [
  { city: '滁州市', limit: 400 },
  { city: '亳州市', limit: 200 },
  { city: '安徽省', limit: 600 },
];

function log(msg: string): void {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  appendFileSync(LOG, line, 'utf8');
  process.stdout.write(line);
}

async function main(): Promise<void> {
  log('=== 串行补完剩余城市 ===');
  for (const c of CITIES) {
    log(`\n──── ${c.city} 开始 ────`);
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('node', ['--no-warnings', 'src/attach.ts', `--city=${c.city}`, `--limit=${c.limit}`], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (d: Buffer) => appendFileSync(LOG, d));
      child.stderr?.on('data', (d: Buffer) => appendFileSync(LOG, d));
      child.on('close', resolve);
    });
    log(`${c.city} 结束 code=${code}`);
  }
  log('\n=== 全部完成 ===');
}

main().catch((e) => {
  log(`异常：${String(e)}`);
  process.exit(1);
});
