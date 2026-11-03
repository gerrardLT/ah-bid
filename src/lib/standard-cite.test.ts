/**
 * 标准号归一化与判定测试。
 *
 *   node --test src/lib/standard-cite.test.ts
 *
 * 重点测三件事：
 * 1. 库里 505 条标准号 100% 可归一化（否则「未收录」会变成假象）
 * 2. GB 与 GB/T 不合并，DB34/ 与 DB34/T 合并（实测混用）
 * 3. 判不出来就说「库内未收录」，绝不凭推测说「废止」
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { buildStandardIndex, extractCitations, judgeCitation, normalizeCode } from './standard-cite.ts';

test('归一化：八种真实形态', () => {
  const cases: Array<[string, string, string | null]> = [
    ['GB 50204-2015', 'GB 50204', '2015'],
    ['GB50204-2015', 'GB 50204', '2015'],
    ['GB/T 50300-2013', 'GB/T 50300', '2013'],
    ['JGJ 59-2011', 'JGJ 59', '2011'],
    ['DB34/T 1469--2019', 'DB34/T 1469', '2019'],
    ['DB34/T 1589—2020', 'DB34/T 1589', '2020'],
    ['GB 50011-2010（2016年版）', 'GB 50011', '2010'],
    ['DB34/ 1466-2019', 'DB34 1466', '2019'],
  ];
  for (const [raw, base, year] of cases) {
    const n = normalizeCode(raw);
    assert.ok(n, `应能归一化：${raw}`);
    assert.equal(n.base, base, `base 错误：${raw}`);
    assert.equal(n.year, year, `year 错误：${raw}`);
  }
});

test('DB 系列宽松匹配：DB34/T 与 DB34/ 同 looseBase', () => {
  assert.equal(normalizeCode('DB34/T 1466-2019')!.looseBase, 'DB34 1466');
  assert.equal(normalizeCode('DB34/ 1466-2011')!.looseBase, 'DB34 1466');
});

test('GB 与 GB/T 不合并（强制 vs 推荐是两个标准）', () => {
  assert.notEqual(normalizeCode('GB 50300')!.base, normalizeCode('GB/T 50300')!.base);
  assert.equal(normalizeCode('GB 50300')!.looseBase, 'GB 50300');
});

test('抽取：不误抓条文号与图集', () => {
  const lines = ['本工程执行 GB 50204-2015 第 5.1.1 条', '图集 12G901-1 不作为强制标准', '参考 GB/T 50300'];
  const cs = extractCitations(lines);
  assert.equal(cs.length, 2, `期望 2 条，实际 ${cs.map((c) => c.raw).join(' / ')}`);
  assert.ok(cs.some((c) => c.base === 'GB 50204' && c.year === '2015'));
  assert.ok(cs.some((c) => c.base === 'GB/T 50300'));
});

test('断行：族根在行尾也能抽', () => {
  const cs = extractCitations(['执行标准：GB', '50204-2015 的规定']);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].base, 'GB 50204');
});

test('全库标准号全部可归一化（仅文件号例外）', () => {
  const db = new DatabaseSync('data/index.db', { readOnly: true });
  const rows = db.prepare('SELECT code FROM standard_ref').all() as Array<{ code: string }>;
  db.close();

  const bad = rows.filter((r) => !normalizeCode(r.code));
  // 库里有两类不是标准号：部门规章（住建部令第37号）、规范性文件（建办质〔2018〕31号）。
  // 它们本就不在核对范围内，归一化返回 null 是正确行为。
  assert.ok(
    bad.every((b) => /令|〔/.test(b.code)),
    `出现意外的非标准号：${bad.map((b) => b.code).join(', ')}`,
  );
  assert.equal(bad.length, 2, `文件号应恰好 2 条，实际：${bad.map((b) => b.code).join(', ')}`);
  assert.ok(rows.length > 500, `standard_ref 条数异常：${rows.length}`);
});

test('判定：旧版给出现行版；未收录不判废止', () => {
  const db = new DatabaseSync('data/index.db', { readOnly: true });
  const idx = buildStandardIndex(db);
  db.close();

  const old = judgeCitation(
    { raw: 'GB 50300-2001', base: 'GB 50300', looseBase: 'GB 50300', year: '2001', line: 0 },
    idx,
  );
  assert.equal(old.verdict, '有更新版');
  assert.ok(old.newer, '有更新版必须给出库内版本');

  const unknown = judgeCitation(
    { raw: 'GB 99999', base: 'GB 99999', looseBase: 'GB 99999', year: null, line: 0 },
    idx,
  );
  assert.equal(unknown.verdict, '库内未收录');

  // 库里 0 条废止记录 —— 任何输入都不该被判「已废止」
  const noYear = judgeCitation(
    { raw: 'GB 50204', base: 'GB 50204', looseBase: 'GB 50204', year: null, line: 0 },
    idx,
  );
  assert.notEqual(noYear.verdict, '已废止');
  assert.ok(noYear.note?.includes('未标年份'), '未标年份必须显式提示');
});
