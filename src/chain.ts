/**
 * 串联下载器：等当前任务结束后，自动依次下载其他城市。
 *
 * 判断"当前任务是否结束"不用进程检测（wmic 在新版 Windows 已移除），
 * 而是看数据库里合肥的附件数是否停止增长——连续 3 次采样无变化才算结束。
 *
 * 用法：
 *   node src/chain.ts
 *
 * 启动建议用 WMI 独立进程，避免被终端 Ctrl+C 带走。
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const LOG = 'data/chain.log';
const HOME_CITY = '合肥市';
/** 采样间隔：2 分钟；连续 3 次（6 分钟）无增长判定结束 */
const SAMPLE_MS = 120_000;
const STABLE_TARGET = 3;

function log(msg: string): void {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  appendFileSync(LOG, line, 'utf8');
  process.stdout.write(line);
}

function cityAttachmentCount(city: string): number {
  const db = new DatabaseSync('data/index.db');
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM attachment t
         JOIN announcement a ON a.guid = t.announcement_guid
         WHERE a.city = ?`,
      )
      .get(city) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 依次下载的城市。未适配的站点会自动跳过（详情页过短），不会报错。 */
const CITIES = [
  { name: '黄山市', note: '已适配 pageRedirect' },
  { name: '马鞍山市', note: '已适配 pageRedirect' },
  { name: '铜陵市', note: '详情页可直取' },
  { name: '淮北市', note: '详情页可直取' },
  { name: '宿州市', note: '需适配 getInfoByID' },
  { name: '六安市', note: '需适配 getInfoByInfoid' },
  { name: '宣城市', note: '需适配 jyxxSearchAction' },
];

async function main(): Promise<void> {
  log('=== 串联下载启动 ===');

  // 1. 等合肥跑完
  log(`等待 ${HOME_CITY} 下载结束（每 ${SAMPLE_MS / 60000} 分钟采样一次）...`);
  let prev = -1;
  let stable = 0;
  for (;;) {
    const n = cityAttachmentCount(HOME_CITY);
    if (n === prev) {
      stable++;
      log(`${HOME_CITY} 附件数未变（${n}），连续 ${stable}/${STABLE_TARGET}`);
      if (stable >= STABLE_TARGET) {
        log(`${HOME_CITY} 判定结束，共 ${n} 个附件`);
        break;
      }
    } else {
      stable = 0;
      log(`${HOME_CITY} 当前 ${n} 个附件`);
    }
    prev = n;
    await sleep(SAMPLE_MS);
  }

  // 2. 串行下载其他城市
  for (const c of CITIES) {
    log(`\n──── 开始 ${c.name}（${c.note}）────`);
    const before = cityAttachmentCount(c.name);

    await new Promise<void>((resolve) => {
      const child = spawn(
        'node',
        ['--no-warnings', 'src/attach.ts', `--city=${c.name}`, '--limit=400'],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout?.on('data', (d: Buffer) => appendFileSync(LOG, d));
      child.stderr?.on('data', (d: Buffer) => appendFileSync(LOG, d));
      child.on('close', (code) => {
        const after = cityAttachmentCount(c.name);
        log(`${c.name} 完成 code=${code}，附件 ${before} → ${after}（+${after - before}）`);
        resolve();
      });
    });
  }

  // 3. 总账
  const db = new DatabaseSync('data/index.db');
  const total = db
    .prepare(`SELECT COUNT(*) n, ROUND(COALESCE(SUM(size_bytes),0)/1073741824.0,2) gb FROM attachment`)
    .get() as { n: number; gb: number };
  db.close();

  log(`\n=== 全部完成 ===`);
  log(`附件总数 ${total.n}，合计 ${total.gb} GB`);
}

main().catch((err) => {
  log(`异常退出：${String(err)}`);
  process.exit(1);
});
