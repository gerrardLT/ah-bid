/**
 * 截止时间抽取的单测。
 *
 * 用例来源：全部取自真实公告正文的形态（含 OCR/转版造成的空格撕裂）。
 * 这里每一条负例都对应线上会出错的真实写法，不是编出来的。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDeadline } from './deadline.ts';

const pub = '2026-11-01';

test('标准句：投标文件提交的截止时间为…', () => {
  const r = parseDeadline('投标文件提交的截止时间为2026年11月12日8时30分。', pub);
  assert.equal(r.date, '2026-11-12');
  assert.equal(r.hhmm, '08:30');
  assert.equal(r.confidence, 'high');
  assert.equal(r.source, 'bid_deadline');
});

test('只要日期没有时刻', () => {
  const r = parseDeadline('投标截止时间为2026年11月12日。', pub);
  assert.equal(r.date, '2026-11-12');
  assert.equal(r.hhmm, null);
});

test('空格撕裂①：「2 026年9月15日」（OCR 把年份拆开）', () => {
  // pubDate 必须与截止日同量级：区间闸是 pub-1 ~ pub+180，
  // 用统一的 2026-11-01 会把 9 月的日期正确挡掉（那是闸在工作，不是 bug）
  const r = parseDeadline('投标截止时间：2 026年9月15日9时00分', '2026-09-01');
  assert.equal(r.date, '2026-09-15');
  assert.equal(r.hhmm, '09:00');
});

test('空格撕裂②：「2026年 4 月 8 日」', () => {
  const r = parseDeadline('投标截止时间为 2026年 4 月 8 日 10 时 00 分', '2026-04-01');
  assert.equal(r.date, '2026-04-08');
  assert.equal(r.hhmm, '10:00');
});

test('空格撕裂③：「202 6 年 2 月 6 日」', () => {
  const r = parseDeadline('开标时间：202 6 年 2 月 6 日 09:30', '2026-02-01');
  assert.equal(r.date, '2026-02-06');
  assert.equal(r.hhmm, '09:30');
});

test('空格撕裂④：ISO 式带空格「2026-11-12 08:30」', () => {
  const r = parseDeadline('投标截止时间 2026-11-12 08:30', pub);
  assert.equal(r.date, '2026-11-12');
  assert.equal(r.hhmm, '08:30');
});

test('反向：日期在锚点之前（「…8时30分，投标人应在投标截止时间前提交」）', () => {
  const r = parseDeadline('开标及投标截止时间为2026年11月12日8时30分，投标人应在投标截止时间前提交。', pub);
  assert.equal(r.date, '2026-11-12');
});

test('负例①：「投标截止时间前三个月内的社保证明」不能当成截止时间', () => {
  // 锚点后面紧跟"前三个月内"，没有日期；窗口内也没有其他日期
  const r = parseDeadline('提供本单位为其缴纳的投标截止时间前三个月内的任意一个月社保证明。', pub);
  assert.equal(r.date, null);
  assert.equal(r.reason, 'no_date_near_anchor');
});

test('负例②：业绩日期早于发布日 180 天以上，必须被区间闸挡掉', () => {
  const r = parseDeadline('投标人自2019年5月1日以来具有类似业绩。投标截止时间为2026年11月12日。', pub);
  assert.equal(r.date, '2026-11-12'); // 抽的是截止时间，不是 2019 那个
});

test('区间闸：只有历史日期时抽不到', () => {
  const r = parseDeadline('投标截止时间详见前附表，业绩要求 2019年5月1日 以后。', pub);
  assert.equal(r.date, null);
  assert.ok(['all_gated', 'no_date_near_anchor'].includes(r.reason ?? ''));
});

test('bid_deadline 优先于 open_time', () => {
  const body = '开标时间为2026年11月13日9时00分。投标截止时间为2026年11月12日9时00分。';
  const r = parseDeadline(body, pub);
  assert.equal(r.date, '2026-11-12');
  assert.equal(r.source, 'bid_deadline');
});

test('没有锚点时给出明确原因', () => {
  const r = parseDeadline('本工程位于合肥市蜀山区，建筑面积约 1.2 万平方米。', pub);
  assert.equal(r.date, null);
  assert.equal(r.reason, 'no_anchor');
});

test('同一锚点附近出现两个不同日期 → 置信度降为 medium 并记录候选数', () => {
  // 两个日期都必须落在 25 字窗口内，否则只会看到一个候选（那也是对的）
  const body = '投标截止时间为2026年11月12日（原定2026年11月5日）。';
  const r = parseDeadline(body, pub);
  assert.ok(r.candidates >= 2);
  assert.equal(r.date, '2026-11-12');
  assert.equal(r.confidence, 'medium');
});
