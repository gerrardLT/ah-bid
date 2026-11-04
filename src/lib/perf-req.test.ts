/**
 * 业绩五要素的单测。八条用例对应四种真实写法 + 四种边界。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePerfReq } from './perf-req.ts';

test('写法①：近X年 + N个 + 后续为准', () => {
  const r = parsePerfReq('3.1.3 提供 2022 年至今，企业类似项目业绩 1 个，以竣工验收时间为准。4.招标文件的获取');
  assert.equal(r.cnt, 1);
  assert.equal(r.kind, '类似');
  assert.equal(r.proof, '以竣工验收为准');
});

test('写法②：近 5 年（有绝对起点）', () => {
  const r = parsePerfReq('投标人近 5 年内具有类似项目业绩。');
  assert.equal(r.years, 5);
  assert.equal(r.kind, '类似');
});

test('写法③：单项合同金额 ≥1000 万元', () => {
  const r = parsePerfReq('类似项目指完工已验收的单项合同金额 1,000 万元及以上的水利工程。');
  assert.equal(r.scope, '单项');
  assert.equal(r.minAmount, 10000000);
});

test('写法④：只写「详见招标文件」→ notice 标记，不是「没抽到」', () => {
  const r = parsePerfReq('业绩要求：详见招标文件第二章投标人须知前附表。');
  assert.equal(r.notice, '见招标文件');
  assert.equal(r.reason, null);
});

test('「业绩要求：/」→ 无门槛（这是有效信息）', () => {
  const r = parsePerfReq('3.2 业绩要求：/。4.招标文件的获取');
  assert.equal(r.notice, '无门槛');
  assert.equal(r.reason, null);
});

test('「不要求业绩」→ 无门槛', () => {
  const r = parsePerfReq('本项目不要求类似项目业绩。');
  assert.equal(r.notice, '无门槛');
});

test('「1 个标段」不能被当成业绩数量', () => {
  const r = parsePerfReq('本项目划分 1 个标段，投标人具有类似项目业绩。');
  assert.equal(r.cnt, null);
  assert.ok(r.missing.includes('cnt'));
});

test('没有业绩句 → reason 明确', () => {
  const r = parsePerfReq('本工程位于合肥市蜀山区，建筑面积约 1.2 万平方米。');
  assert.equal(r.reason, 'no_perf_sentence');
  assert.equal(r.notice, null);
});
