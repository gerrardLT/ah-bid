/**
 * 资格条件抽取器的单测。用例取自真实公告的写法。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseClauses } from './clauses.ts';

test('标准资格段：资质 + 建造师 + 联合体', () => {
  const body =
    '3.1 投标人资格要求：投标人须具备建筑工程施工总承包一级及以上资质，' +
    '项目经理须为一级建造师（建筑工程），本项目不接受联合体投标。' +
    '4. 招标文件的获取：2026年11月5日至11月10日。';
  const r = parseClauses(body);
  assert.match(r.qualification ?? '', /建筑工程施工总承包一级/);
  assert.match(r.builder ?? '', /一级建造师/);
  assert.equal(r.jointVenture, 0);
  assert.equal(r.reason, null);
});

test('「不接受联合体」不能被「接受联合体」抢先匹配', () => {
  // 关键：不接受联合体 里也含 接受联合体
  const r = parseClauses('投标人资格要求：本项目不接受联合体投标。招标文件的获取：...');
  assert.equal(r.jointVenture, 0);
});

test('明确接受联合体 → 1（与"没提"区分）', () => {
  const r = parseClauses('投标人资格要求：本项目接受联合体投标，联合体成员不超过 2 家。招标文件的获取：...');
  assert.equal(r.jointVenture, 1);
});

test('没提联合体 → null（不是 0）', () => {
  const r = parseClauses('投标人资格要求：投标人须具备市政公用工程施工总承包二级资质。招标文件的获取：...');
  assert.equal(r.jointVenture, null);
});

test('业绩门槛', () => {
  const r = parseClauses('投标人资格要求：近3年内具有1个类似项目业绩。招标文件的获取：...');
  assert.match(r.performance ?? '', /近3年1个类似业绩/);
});

test('没有资格要求段 → reason 明确', () => {
  const r = parseClauses('本工程位于合肥市蜀山区，建筑面积约 1.2 万平方米。');
  assert.equal(r.reason, 'no_section');
  assert.equal(r.confidence, 'none');
});

test('有段但一项都没抽到 → no_field_matched（不是"确认没有"）', () => {
  const r = parseClauses(
    '投标人资格要求：详见招标文件第二章投标人须知前附表。招标文件的获取：详见附件。',
  );
  assert.equal(r.reason, 'no_field_matched');
  assert.equal(r.jointVenture, null);
});
