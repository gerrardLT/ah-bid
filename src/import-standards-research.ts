/**
 * 把 data/standards-research.json 的调研发现导入 standard_research 表。
 *
 * 为什么单独一张表：standard_ref 存「结论」，这张表存「怎么得出这个结论」。
 * 标准状态会变，版本冲突、替代关系、来源线索是复用的关键——只存清单会丢失判断依据。
 *
 * 用法：node --no-warnings src/import-standards-research.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = 'data';

interface Finding {
  topic: string;
  keyword: string;
  finding: string;
  evidence: string;
  impact: string;
  severity: string;
  resolved: boolean;
}

const json = JSON.parse(readFileSync(join(DATA, 'standards-research.json'), 'utf8')) as {
  findings: Finding[];
};

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');
db.exec(`
CREATE TABLE IF NOT EXISTS standard_research (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic       TEXT NOT NULL,   -- 体系变更/版本替代/版本废止/来源冲突/数据源质量/方案否决/待核实/意外收获
  keyword     TEXT NOT NULL,   -- 检索关键词
  finding     TEXT NOT NULL,   -- 结论
  evidence    TEXT NOT NULL,   -- 证据（来源与原文要点）
  impact      TEXT,            -- 对技术标编写的影响
  severity    TEXT NOT NULL,   -- 高/中/低
  resolved    INTEGER NOT NULL,-- 1 = 已定论；0 = 仍存疑，使用前必须复核
  recorded_at TEXT NOT NULL,
  UNIQUE(keyword, finding)
);
CREATE INDEX IF NOT EXISTS idx_sr_sev ON standard_research(severity);
CREATE INDEX IF NOT EXISTS idx_sr_resolved ON standard_research(resolved);
`);

const ins = db.prepare(`
INSERT INTO standard_research (topic, keyword, finding, evidence, impact, severity, resolved, recorded_at)
VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT(keyword, finding) DO UPDATE SET
  topic=excluded.topic, evidence=excluded.evidence, impact=excluded.impact,
  severity=excluded.severity, resolved=excluded.resolved`);
const now = new Date().toISOString();
for (const f of json.findings) {
  ins.run(f.topic, f.keyword, f.finding, f.evidence, f.impact, f.severity, f.resolved ? 1 : 0, now);
}

const rows = db
  .prepare('SELECT topic, COUNT(*) n FROM standard_research GROUP BY topic ORDER BY n DESC')
  .all() as Array<{ topic: string; n: number }>;
console.log(`调研发现入库 ${json.findings.length} 条：`);
for (const r of rows) console.log(`  ${r.topic.padEnd(10)} ${r.n} 条`);

const un = db.prepare('SELECT keyword, severity FROM standard_research WHERE resolved=0 ORDER BY severity').all() as Array<{
  keyword: string;
  severity: string;
}>;
console.log(`\n仍存疑 ${un.length} 条（使用前必须复核）：`);
for (const r of un) console.log(`  [${r.severity}] ${r.keyword}`);
db.close();
