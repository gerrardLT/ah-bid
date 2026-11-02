/**
 * 招标文件批量结构化提取（P0 + P2 的落地）。
 *
 * 输入：attachment 里所有「招标文件」PDF
 * 产出：
 *   tender_doc    —— 每份文件一行：评标办法、技术/商务/报价分值、控制价、工期、章节页码、文本质量
 *   scoring_item  —— 评分表逐行（评分因素 / 分值 / 评分标准），供后续统计高频评分点
 *
 * 为什么要 Python：Node 侧没有可用的 PDF 解析与表格识别能力，
 * PyMuPDF 能同时给文本和表格，本机已具备（fitz/pdfplumber 均已安装）。
 *
 * 用法：
 *   node --no-warnings src/extract-docs.ts                # 只统计待处理量
 *   node --no-warnings src/extract-docs.ts --limit=20     # 处理 20 份
 *   node --no-warnings src/extract-docs.ts --all          # 全量
 *   node --no-warnings src/extract-docs.ts --all --redo   # 重跑已提取的
 */

import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = 'data';
const JSON_BEGIN = '@@TENDER_JSON_BEGIN@@';
const JSON_END = '@@TENDER_JSON_END@@';

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};
const LIMIT = argOf('limit') ? Number(argOf('limit')) : 0;
const ALL = process.argv.includes('--all');
const REDO = process.argv.includes('--redo');
/** 指定重跑的 attach_guid 清单文件（每行一个）。用于只重跑某一批坏结果的修复 */
const REDO_GUIDS = argOf('redo-guids');

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');
db.exec(`
CREATE TABLE IF NOT EXISTS tender_doc (
  attach_guid       TEXT PRIMARY KEY,
  announcement_guid TEXT NOT NULL,
  pages             INTEGER,
  text_chars        INTEGER,
  text_quality      TEXT,
  evaluation_method TEXT,
  score_technical   REAL,
  score_commercial  REAL,
  score_price       REAL,
  score_credit      REAL,
  score_verified    INTEGER NOT NULL DEFAULT 0,
  weight_note       TEXT,
  weight_evidence   TEXT,
  money_json        TEXT,
  duration_json     TEXT,
  sections_json     TEXT,
  scoring_table_count INTEGER NOT NULL DEFAULT 0,
  pdf_path          TEXT,
  extracted_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scoring_item (
  attach_guid TEXT NOT NULL,
  page        INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  cells_json  TEXT NOT NULL,
  PRIMARY KEY (attach_guid, page, seq)
);
CREATE INDEX IF NOT EXISTS idx_tdoc_ann ON tender_doc(announcement_guid);
`);

// 前几轮建的表没有 score_credit（安徽存在四项制评分），补列。
try {
  db.exec('ALTER TABLE tender_doc ADD COLUMN score_credit REAL');
} catch {
  /* 列已存在 */
}

interface Row {
  g: string;
  ag: string;
  p: string;
  sz: number;
}

const rows = db
  .prepare(
    `SELECT t.attach_guid g, t.announcement_guid ag, t.local_path p, t.size_bytes sz
     FROM attachment t
     WHERE t.status='ok' AND t.local_path IS NOT NULL
       -- 只要「招标文件正文」本体：LIKE '%招标文件%' 会把「招标文件补疑1.pdf」
       -- 「招标文件澄清.pdf」这类 1～3 页的衍生文件一并带入，它们是另一类材料，
       -- 混进来会让“提取成功率”和“评分表数量”全失真。
       AND t.filename LIKE '%招标文件%'
       AND t.filename NOT LIKE '%补疑%' AND t.filename NOT LIKE '%澄清%'
       AND t.filename NOT LIKE '%变更%' AND t.filename NOT LIKE '%答疑%'
       AND t.filename NOT LIKE '%更正%' AND t.filename NOT LIKE '%补充%'
       AND t.size_bytes > 300000
     ORDER BY t.size_bytes ASC`,
  )
  .all() as unknown as Row[];

const done = new Set(
  (db.prepare('SELECT attach_guid g FROM tender_doc').all() as Array<{ g: string }>).map((r) => r.g),
);
const todo = REDO ? rows : rows.filter((r) => !done.has(r.g));
// --from=N：重跑时跳过前 N 份，用于分批重跑（长任务容易中断，一次跑完 1900+ 份风险高）
const FROM = Number(argOf('from') ?? 0);
const batch = REDO_GUIDS
  ? rows.filter((r) => guidsFile(REDO_GUIDS).has(r.g))
  : ALL
    ? todo
    : todo.slice(FROM, FROM + (LIMIT || 5));

function guidsFile(path: string): Set<string> {
  return new Set(readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}

// 清理之前用宽泛条件误收的衍生文件（补疑/澄清/变更）的提取结果，
// 否则 tender_doc 里会混进“215 页｜无分值构成”这类看着像失败、实际是选错文件的行。
const junk = db
  .prepare(
    `SELECT attach_guid g FROM tender_doc
     WHERE pdf_path LIKE '%补疑%' OR pdf_path LIKE '%澄清%' OR pdf_path LIKE '%变更%'
        OR pdf_path LIKE '%答疑%' OR pdf_path LIKE '%更正%'`,
  )
  .all() as Array<{ g: string }>;
if (junk.length) {
  const delDoc = db.prepare('DELETE FROM tender_doc WHERE attach_guid = ?');
  const delItem2 = db.prepare('DELETE FROM scoring_item WHERE attach_guid = ?');
  for (const j of junk) {
    delDoc.run(j.g);
    delItem2.run(j.g);
  }
  console.log(`已清理误收的衍生文件提取结果 ${junk.length} 行`);
}

console.log(`招标文件 PDF 共 ${rows.length} 份；已提取 ${done.size}；待处理 ${todo.length}；本次处理 ${batch.length}`);

const insDoc = db.prepare(`
  INSERT INTO tender_doc (attach_guid, announcement_guid, pages, text_chars, text_quality,
    evaluation_method, score_technical, score_commercial, score_price, score_credit, score_verified,
    weight_note, weight_evidence, money_json, duration_json, sections_json,
    scoring_table_count, pdf_path, extracted_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(attach_guid) DO UPDATE SET
    pages=excluded.pages, text_chars=excluded.text_chars, text_quality=excluded.text_quality,
    evaluation_method=excluded.evaluation_method,
    score_technical=excluded.score_technical, score_commercial=excluded.score_commercial,
    score_price=excluded.score_price, score_credit=excluded.score_credit,
    score_verified=excluded.score_verified,
    weight_note=excluded.weight_note, weight_evidence=excluded.weight_evidence,
    money_json=excluded.money_json, duration_json=excluded.duration_json,
    sections_json=excluded.sections_json, scoring_table_count=excluded.scoring_table_count,
    pdf_path=excluded.pdf_path, extracted_at=excluded.extracted_at`);
const delItems = db.prepare('DELETE FROM scoring_item WHERE attach_guid = ?');
const insItem = db.prepare(
  'INSERT OR REPLACE INTO scoring_item (attach_guid, page, seq, cells_json) VALUES (?,?,?,?)',
);

/**
 * 单份 PDF 的解析上限。实测最长 450 页约 40 秒；超过 3 分钟视为卡死。
 * 不加超时的话，一份损坏 PDF 会让整个批处理永久挂住（长任务通常没人盯着）。
 */
const PY_TIMEOUT_MS = 180_000;

function runPython(abs: string): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn('python', ['src/extract_tender.py', abs], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ error: `解析超时（>${PY_TIMEOUT_MS / 1000}s），已终止子进程` });
    }, PY_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: `spawn 失败：${String(e)}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const bi = out.indexOf(JSON_BEGIN);
      const ei = out.indexOf(JSON_END);
      if (bi < 0 || ei < bi) return resolve({ error: '未找到 JSON 边界标记', stderr: err.slice(-200) });
      try {
        resolve(JSON.parse(out.slice(bi + JSON_BEGIN.length, ei)));
      } catch (e) {
        resolve({ error: `JSON 解析失败：${String(e).slice(0, 80)}` });
      }
    });
  });
}

let ok = 0;
let failed = 0;
let verified = 0;
const t0 = Date.now();

for (const [i, r] of batch.entries()) {
  const abs = join(DATA, r.p);
  if (!existsSync(abs)) {
    console.log(`  [${i + 1}/${batch.length}] 文件缺失，跳过：${r.p}`);
    db.prepare("UPDATE attachment SET status='failed', reason='本地文件缺失，无法提取' WHERE attach_guid=?").run(r.g);
    failed++;
    continue;
  }
  const j = await runPython(abs);
  if (j.error) {
    console.log(`  [${i + 1}/${batch.length}] ✗ ${j.error}  ${r.p.slice(-50)}`);
    failed++;
    continue;
  }
  const w = j.score_weights ?? {};
  // 可信性：至少两个维度，合计 = 100（容差 1）。
  // 不能要求 price：监理大纲类项目只有“商务 80 + 技术 20”两项，报价开标后才评。
  const vals = [w.technical, w.commercial, w.price, w.credit].filter((v: number | null) => v != null) as number[];
  const verifiedFlag =
    w.technical != null && vals.length >= 2 && Math.abs(vals.reduce((a, b) => a + b, 0) - 100) <= 1;
  if (verifiedFlag) verified++;

  insDoc.run(
    r.g,
    r.ag,
    j.pages ?? null,
    j.text_chars ?? null,
    j.text_quality ?? null,
    j.evaluation_method ?? null,
    w.technical ?? null,
    w.commercial ?? null,
    w.price ?? null,
    w.credit ?? null,
    verifiedFlag ? 1 : 0,
    j.score_weights_note ?? null,
    JSON.stringify(j.weight_evidence ?? []),
    JSON.stringify(j.money_facts ?? []),
    JSON.stringify(j.duration_days_candidates ?? []),
    JSON.stringify(j.sections ?? {}),
    (j.scoring_tables ?? []).length,
    r.p,
    new Date().toISOString(),
  );
  delItems.run(r.g);
  let seq = 0;
  // 同一张评分表跨页时会被重复抽出（实测同一张“技术标评审（20分）”能出现 6 次），
  // 按整行内容去重，避免 scoring_item 被重复行撑大、后续统计高频评分点时被重复计数。
  const seenRows = new Set<string>();
  for (const t of j.scoring_tables ?? []) {
    for (const cells of t.rows ?? []) {
      const key = JSON.stringify(cells);
      if (seenRows.has(key)) continue;
      seenRows.add(key);
      insItem.run(r.g, t.page ?? 0, seq++, key);
    }
  }
  ok++;
  const tag = verifiedFlag ? '✓分值已验证' : j.text_quality === 'low' ? '⚠扫描件' : j.score_weights_note ? '⚠分值待复核' : '·无分值构成';
  console.log(
    `  [${i + 1}/${batch.length}] ${tag}  ${j.pages}页  评分表${(j.scoring_tables ?? []).length}个  ${r.p.slice(-46)}`,
  );
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n完成：成功 ${ok}，失败 ${failed}，分值三项齐全 ${verified}；耗时 ${secs}s`);
const stat = db.prepare('SELECT COUNT(*) n, SUM(score_verified) v FROM tender_doc').get() as { n: number; v: number };
const item = db.prepare('SELECT COUNT(*) n FROM scoring_item').get() as { n: number };
console.log(`库里累计：tender_doc ${stat.n} 行（其中分值已验证 ${stat.v ?? 0}），scoring_item ${item.n} 行`);
db.close();
