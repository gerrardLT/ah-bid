/**
 * 一次性跑完剩余已适配城市（宿州、六安、宣城）。
 * 用 node 串行调用子进程，避免 bat 的中文编码问题。
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const LOG = 'data/attach-rest.log';
const CITIES = ['宿州市', '六安市', '宣城市'];

function log(msg: string): void {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  appendFileSync(LOG, line, 'utf8');
  process.stdout.write(line);
}

async function main(): Promise<void> {
  log('=== 剩余城市批量下载启动 ===');
  for (const city of CITIES) {
    log(`\n──── ${city} 开始 ────`);
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('node', ['--no-warnings', 'src/attach.ts', `--city=${city}`, '--limit=300'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (d: Buffer) => appendFileSync(LOG, d));
      child.stderr?.on('data', (d: Buffer) => appendFileSync(LOG, d));
      child.on('close', resolve);
    });
    log(`${city} 结束 code=${code}`);
  }
  log('\n=== 全部完成 ===');
}

main().catch((e) => {
  log(`异常：${String(e)}`);
  process.exit(1);
});
