/**
 * 工程本体信号的渲染测试。
 *
 *   node --test src/lib/selfcheck/context-report.test.ts
 *
 * 三条底线（都是"会不会骗人"的问题）：
 * 1. 没有澄清数据 → 必须说"没有"，不能编关注点
 * 2. 样本不足 → 必须说"无可靠基准"，不能给紧/宽
 * 3. 库内未收录 → 不能写成"废止"（库内 0 条废止记录）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectContext } from '../project-context.ts';
import { renderContextSection } from './context-report.ts';

function ctxOf(over: Partial<ProjectContext> = {}): ProjectContext {
  return {
    announcementGuid: 'x',
    projectType: null,
    qa: { n: 0, items: [], unclassified: [], confidence: 'global' },
    schedule: { days: null, baseline: null, baselineName: '', level: '无可靠基准' },
    limit: { amount: null, tier: null, baseline: null },
    standards: {
      located: false,
      cited: 0,
      findings: [],
      missingCore: [],
      missingMandatory: [],
      typeKnown: false,
      confidence: 'low',
    },
    notes: [],
    ...over,
  };
}

test('无澄清数据 → 明说没有，不编关注点', () => {
  const md = renderContextSection(ctxOf());
  assert.ok(md.includes('没有澄清数据'));
  assert.ok(!md.includes('| 主题 |'));
});

test('样本不足 → 无可靠基准，不给紧/宽', () => {
  const md = renderContextSection(
    ctxOf({ schedule: { days: 120, baseline: null, baselineName: '', level: '无可靠基准', note: '同类样本不足（n=12）' } }),
  );
  assert.ok(md.includes('无可靠基准'));
  // 渲染里有「「偏紧/偏宽」是统计位置」这句说明，只检查表格数据行不能出现判断结论
  const row = md.split('\n').find((l) => l.startsWith('| 工期'));
  assert.ok(row, '应有工期数据行');
  assert.ok(!row!.includes('偏紧') && !row!.includes('偏宽'), `工期行不应给判定：${row}`);
});

test('库内未收录不能写成废止', () => {
  const md = renderContextSection(
    ctxOf({
      standards: {
        located: true,
        cited: 2,
        findings: [
          { raw: 'GB 50204-2015', verdict: '现行', libCode: 'GB 50204-2015', line: 3 },
          { raw: 'GB 99999', verdict: '库内未收录', line: 4 },
        ],
        missingCore: [],
        missingMandatory: [],
        typeKnown: true,
        confidence: 'high',
      },
    }),
  );
  assert.ok(md.includes('库内未收录'));
  assert.ok(md.includes('不代表标准错误或废止'));
});

test('有澄清时表格带分母与置信度', () => {
  const md = renderContextSection(
    ctxOf({
      qa: {
        n: 40,
        items: [{ topicId: 'QA-PERF', name: '业绩认定', count: 12, share: 0.3, scoring: 5, examples: ['业绩能否重复？'] }],
        unclassified: ['锅炉预留空间按几台考虑'],
        confidence: 'project',
      },
    }),
  );
  assert.ok(md.includes('40 条澄清'));
  assert.ok(md.includes('本项目数据'));
  assert.ok(md.includes('业绩认定'));
  assert.ok(md.includes('锅炉预留空间')); // 项目专属问题必须露出
});

test('降级说明会出现在报告里', () => {
  const md = renderContextSection(ctxOf({ notes: ['未指定项目类型，不判强制规范漏引'] }));
  assert.ok(md.includes('本次的降级与说明'));
  assert.ok(md.includes('未指定项目类型'));
});
