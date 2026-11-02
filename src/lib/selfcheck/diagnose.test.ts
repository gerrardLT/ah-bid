/**
 * 诊断核心的单元测试。零依赖，直接用 node --test。
 *
 *   node --test src/lib/selfcheck/diagnose.test.ts
 *
 * 只测三件事（其余靠 eval 的合成标）：
 *   1. 三态语义：missing / mentioned / covered 不能混
 *   2. 档位单调：证据命中数增加，档位只升不降
 *   3. 证据定位带行号（没有行号的"已覆盖"是不可核对的）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, splitSections, type HeadingRule } from '../bid-text.ts';
import { compileEvidence } from './compile-rules.ts';
import { diagnose, tally } from './diagnose.ts';
import type { Check, Ruleset, Tier, Topic } from './types.ts';

const HEADINGS: HeadingRule[] = [
  { topicId: 'T1', aliases: ['进度计划'] },
  { topicId: 'T2', aliases: ['平面布置'] },
];

function makeRuleset(): Ruleset {
  const topics: Topic[] = [
    { id: 'T1', name: '进度', appliesTo: ['通用'], headings: ['进度计划'], parent: null, sourceRow: 2 },
    { id: 'T2', name: '平面', appliesTo: ['通用'], headings: ['平面布置'], parent: null, sourceRow: 3 },
  ];
  const mk = (id: string, topicId: string, ev: string[]): Check => ({
    id,
    topicId,
    title: id,
    aliases: [],
    evidence: ev.map(compileEvidence),
    rejectIfMissing: false,
    source: 'test',
    reviewed: '2026-11-02',
    expertNote: '',
    sourceRow: 2,
  });
  const checks: Check[] = [
    mk('C1', 'T1', ['term:横道图', 'term:网络图']),
    mk('C2', 'T2', ['term:塔吊', 'term:围挡']),
  ];
  const t = (id: string): Tier[] => [
    { checkId: id, level: 1, minEvidence: 1, label: '合格' },
    { checkId: id, level: 2, minEvidence: 2, label: '良好' },
  ];
  return { schemaVersion: 1, hash: 'test', compiledAt: '', topics, checks, tiers: { C1: t('C1'), C2: t('C2') } };
}

function docOf(text: string) {
  const t = normalize(text);
  const { sections, unsegmented } = splitSections(t, HEADINGS);
  return { path: 'x', text: t, lines: t.split('\n'), sections, unsegmented, chars: t.length };
}

test('无任何章节 → 全部 missing', () => {
  const r = diagnose(docOf('本投标文件内容如下。'), makeRuleset());
  const t = tally(r.diagnoses);
  assert.equal(t.missing, 2);
  assert.equal(t.mentioned, 0);
  assert.equal(t.covered, 0);
  assert.equal(r.sectionCoverage, 0);
});

test('章节在但零证据 → mentioned（空话标必须被识别）', () => {
  const text = [
    '一、施工进度计划',
    '本项目将认真做好进度管理，确保工期目标实现。',
    '',
    '二、施工现场平面布置',
    '布置科学合理，满足施工需要。',
  ].join('\n');
  const r = diagnose(docOf(text), makeRuleset());
  const t = tally(r.diagnoses);
  assert.equal(t.mentioned, 2, '标题在但无证据应判 mentioned，不能判 covered');
  assert.equal(t.covered, 0);
  assert.equal(r.sectionCoverage, 1);
  // mentioned 的档位必须为空——无证据不能给档
  assert.ok(r.diagnoses.every((d) => d.tier === null));
});

test('命中一项 → covered + 最低档，且证据带行号', () => {
  const text = [
    '一、施工进度计划',
    '采用横道图对施工进度进行动态控制，每周比对计划完成情况。',
    '',
    '二、施工现场平面布置',
    '现场设置塔吊一台，覆盖全部施工作业区域。',
  ].join('\n');
  const r = diagnose(docOf(text), makeRuleset());
  const c1 = r.diagnoses.find((d) => d.checkId === 'C1')!;
  assert.equal(c1.state, 'covered');
  assert.equal(c1.tier?.level, 1);
  assert.equal(c1.hits.length, 1);
  assert.ok(c1.hits[0].line >= 0, '证据必须带行号');
  assert.ok(c1.hits[0].snippet.includes('横道图'), '证据摘录要含命中词');
  assert.deepEqual(c1.missing, ['term:网络图']);
});

test('命中两项 → 升到高档（档位随证据数单调）', () => {
  const text = [
    '一、施工进度计划',
    '采用横道图与网络图对施工进度进行动态控制，每周比对计划完成情况。',
    '',
    '二、施工现场平面布置',
    '现场设置塔吊一台，四周设围挡封闭管理。',
  ].join('\n');
  const r = diagnose(docOf(text), makeRuleset());
  const c1 = r.diagnoses.find((d) => d.checkId === 'C1')!;
  assert.equal(c1.state, 'covered');
  assert.equal(c1.tier?.level, 2, '两项证据应升到 level 2');
  assert.equal(c1.missing.length, 0);
});

test('档位单调：证据数 0→1→2 时 tier 级别不下降', () => {
  const levels: Array<number | null> = [];
  const variants = [
    ['一、施工进度计划', '做好进度管理。'],
    ['一、施工进度计划', '采用横道图对施工进度进行动态控制，每周比对计划完成情况。'],
    ['一、施工进度计划', '采用横道图与网络图对施工进度进行动态控制，每周比对计划完成情况。'],
  ];
  for (const lines of variants) {
    const r = diagnose(docOf(lines.join('\n')), makeRuleset());
    const c1 = r.diagnoses.find((d) => d.checkId === 'C1')!;
    levels.push(c1.tier?.level ?? 0);
  }
  assert.deepEqual(levels, [0, 1, 2], '档位必须是 0→1→2 单调递增');
});
