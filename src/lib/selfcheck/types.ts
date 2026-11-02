/**
 * 自检规则的领域类型。
 *
 * 设计约束（见 rules/v1/README.md）：
 * - 规则是数据，不是代码：新增章节/检查项只改 CSV
 * - 档位只由 tiers.csv 的 min_evidence 决定，代码里不写任何分数阈值
 * - 代码里不出现项目类型字面量（房建/市政…），类型只以 appliesTo 数据字段存在
 */

export type EvidenceKind = 'term' | 'number' | 'section' | 'cite' | 'regex' | 'volume';

export interface Evidence {
  kind: EvidenceKind;
  /** 原始 pattern（CSV 里写的） */
  pattern: string;
  /** 编译后的正则；term/section 已转义，number 追加了"附近有数字"的约束；volume 用永不匹配的占位 */
  re: RegExp;
  /** 报告里显示的名字，默认等于 pattern */
  label: string;
  /** 仅 volume：该章节正文字数下限 */
  minChars?: number;
}

export interface Check {
  id: string;
  topicId: string;
  title: string;
  /** 评分表里可能的叫法，用于把评分项对到规则 */
  aliases: string[];
  evidence: Evidence[];
  /** 缺了直接出局 */
  rejectIfMissing: boolean;
  /** 规则来源，必填（招标文件页码 / 规范条款 / 专家名） */
  source: string;
  /** 最近核对日期 YYYY-MM-DD */
  reviewed: string;
  expertNote: string;
  /** 来自 checks.csv 的行号，报错定位用 */
  sourceRow: number;
}

export interface Tier {
  checkId: string;
  /** 1 低 2 中 3 高 */
  level: number;
  /** 至少命中几项证据 */
  minEvidence: number;
  label: string;
}

export interface Topic {
  id: string;
  name: string;
  appliesTo: string[];
  /** 标题别名，切章节用 */
  headings: string[];
  parent: string | null;
  sourceRow: number;
}

export interface Ruleset {
  schemaVersion: number;
  /** 规则内容指纹（不含编译时间），报告头部展示 */
  hash: string;
  compiledAt: string;
  topics: Topic[];
  checks: Check[];
  /** checkId → 按 minEvidence 升序的档位 */
  tiers: Record<string, Tier[]>;
}

export type DiagState = 'covered' | 'mentioned' | 'missing';

export interface EvidenceHit {
  checkId: string;
  kind: EvidenceKind;
  pattern: string;
  /** 0 基行号 */
  line: number;
  snippet: string;
}

export interface Diagnosis {
  checkId: string;
  topicId: string;
  title: string;
  state: DiagState;
  /** 命中的证据（带行号） */
  hits: EvidenceHit[];
  /** 未命中的证据 pattern，报告里告诉用户"缺什么" */
  missing: string[];
  /** 推定档位；原文不可读或证据为 0 时为 null */
  tier: { level: number; label: string } | null;
  rejectRisk: boolean;
  /** 命中的章节标题；null 表示该 topic 在文中没找到 */
  section: string | null;
  /** 仅章节级检查（volume）：该章节去标题、去空白后的实际正文字数 */
  bodyChars?: number;
}
