/**
 * 规则库校验 CLI：校验 + 生成快照 + 源码合规扫描。
 *
 * 用法：
 *   node --no-warnings src/selfcheck-validate.ts            # 只校验
 *   node --no-warnings src/selfcheck-validate.ts --write    # 校验通过后写 rules/build/v1.json
 *
 * 退出码：0 通过（warn 不算失败）｜2 有 error
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadRules, summarize, validateRules, type RuleIssue } from './lib/selfcheck/rules.ts';

const write = process.argv.includes('--write');
const RULES_DIR = 'rules/v1';
const BUILD_PATH = join('rules', 'build', 'v1.json');

const { ruleset, issues } = loadRules(RULES_DIR);
const all: RuleIssue[] = [...issues];

if (ruleset) {
  all.push(...validateRules(ruleset));
}

// ---- 源码合规扫描：诊断层不许出现项目类型字面量 / evaluationMethod 分支 ----
const GUARD_FILES = ['src/lib/selfcheck/diagnose.ts', 'src/lib/selfcheck/match.ts'];
const FORBIDDEN_TYPES = [
  '房建',
  '市政',
  '园林',
  '水利',
  '电力',
  '光伏',
  '智能化',
  '老旧小区',
  '装配式',
  '监理设计',
];

for (const f of GUARD_FILES) {
  if (!existsSync(f)) continue;
  const src = readFileSync(f, 'utf8');
  // 去掉注释再扫，避免注释里的说明性文字误报
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const w of FORBIDDEN_TYPES) {
    if (code.includes(`'${w}'`) || code.includes(`"${w}"`)) {
      all.push({
        where: f,
        message: `出现项目类型字面量「${w}」——类型只能来自 rules 的 applies_to 字段`,
        severity: 'error',
      });
    }
  }
  if (/evaluationMethod\s*===/.test(code)) {
    all.push({
      where: f,
      message: '出现 evaluationMethod 分支——评标办法差异应写进规则，不要写进代码',
      severity: 'error',
    });
  }
}

const errors = all.filter((x) => x.severity === 'error');
const warns = all.filter((x) => x.severity === 'warn');

if (ruleset) {
  console.log(summarize(ruleset));
  const byType = new Map<string, number>();
  for (const c of ruleset.checks) {
    const t = ruleset.topics.find((x) => x.id === c.topicId);
    const k = t ? `${t.id} ${t.name}` : c.topicId;
    byType.set(k, (byType.get(k) ?? 0) + 1);
  }
  console.log('\n各章节检查项：');
  for (const [k, v] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${v}`);
  }
}

if (warns.length) {
  console.log(`\n警告 ${warns.length} 条：`);
  for (const w of warns.slice(0, 20)) console.log(`  [warn] ${w.where} ${w.message}`);
  if (warns.length > 20) console.log(`  ……还有 ${warns.length - 20} 条`);
}

if (errors.length) {
  console.log(`\n错误 ${errors.length} 条：`);
  for (const e of errors) console.log(`  [error] ${e.where} ${e.message}`);
  process.exit(2);
}

if (write && ruleset) {
  mkdirSync(dirname(BUILD_PATH), { recursive: true });
  writeFileSync(BUILD_PATH, JSON.stringify(ruleset, null, 2), 'utf8');
  console.log(`\n已写入快照：${BUILD_PATH}`);
}

console.log(`\n校验通过${warns.length ? `（${warns.length} 条警告）` : ''}`);
