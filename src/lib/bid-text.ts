/**
 * 技术标文本层：加载 → 归一化 → 按标题切章节 → 证据定位。
 *
 * 为什么单独一层：假阴性（明明写了却判缺失）几乎全部来自这里——
 * 全角/零宽字符、Word 断行、标题识别失败。所以这一层是纯函数、零数据库依赖、
 * 可以单独测。
 *
 * 章节标题的别名**全部来自规则库**（rules/v1/topics.csv 的 headings 列），
 * 代码里不写任何章节名——否则新增一个章节就要改代码。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export interface HeadingRule {
  topicId: string;
  aliases: string[];
}

export interface Section {
  /** 命中的 topic；标题是编号但没命中别名时为 null */
  topicId: string | null;
  title: string;
  level: number;
  startLine: number;
  endLine: number;
  text: string;
}

export interface SplitResult {
  sections: Section[];
  /** 全文没有识别出任何标题 —— 上层必须显式告知，不能当成"章节都缺" */
  unsegmented: boolean;
}

/** .docx 走 Python 标准库解析（零依赖），其余按 UTF-8 直读。 */
export function loadBidText(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.docx') {
    return execFileSync('python', ['src/docx-text.py', path], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  return readFileSync(path, 'utf8');
}

/**
 * 归一化：NFKC（全角→半角、兼容字符）、去零宽、统一换行、压空行。
 * 不做"合并断行"——技术标里表格行是重要证据，合并会破坏列边界。
 */
export function normalize(text: string): string {
  let t = text.normalize('NFKC');
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, '');
  t = t.replace(/\r\n?/g, '\n');
  t = t.replace(/[ \t]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t;
}

/** 编号形态：第一章 / 一、 / 1.1 / （一） / 1、 */
const NUM_RE =
  /^(第[一二三四五六七八九十百\d]{1,3}[章节部分]|[一二三四五六七八九十]{1,3}、|\d+(?:\.\d+){0,3}[、.\s]|（[一二三四五六七八九十]{1,3}）)/;

export function levelOf(line: string): number {
  if (/^第[一二三四五六七八九十百\d]{1,3}章/.test(line)) return 1;
  if (/^第[一二三四五六七八九十百\d]{1,3}节/.test(line)) return 2;
  if (/^[一二三四五六七八九十]{1,3}、/.test(line)) return 2;
  if (/^（[一二三四五六七八九十]{1,3}）/.test(line)) return 3;
  const m = /^(\d+(?:\.\d+){0,3})/.exec(line);
  if (m) return m[1].split('.').length;
  return 3;
}

/**
 * 标题行判定：长度 ≤ 40、不以句读结尾（纯编号开头除外）、命中别名或编号。
 * 别名用最长匹配——「施工总平面布置图」比「平面布置」更具体。
 */
export function isHeading(
  line: string,
  rules: HeadingRule[],
): { hit: boolean; topicId: string | null } {
  const s = line.trim();
  if (!s || s.length > 40) return { hit: false, topicId: null };
  const startsWithNum = NUM_RE.test(s);
  if (!startsWithNum && /[。；，]$/.test(s)) return { hit: false, topicId: null };

  let best: { topicId: string; len: number } | null = null;
  for (const r of rules) {
    for (const a of r.aliases) {
      if (!a) continue;
      if (s.includes(a) && (!best || a.length > best.len)) {
        best = { topicId: r.topicId, len: a.length };
      }
    }
  }
  if (best) return { hit: true, topicId: best.topicId };
  if (startsWithNum) return { hit: true, topicId: null };
  return { hit: false, topicId: null };
}

/**
 * 切章节：每个标题行开始一个新段，直到下一个标题行。
 * 无标题时返回单段 + unsegmented=true（上层据此提示"请加标题"）。
 */
export function splitSections(text: string, rules: HeadingRule[] = []): SplitResult {
  const lines = text.split('\n');
  const heads: Array<{ i: number; title: string; topicId: string | null; level: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const h = isHeading(lines[i], rules);
    if (h.hit) {
      heads.push({ i, title: lines[i].trim(), topicId: h.topicId, level: levelOf(lines[i].trim()) });
    }
  }

  if (heads.length === 0) {
    return {
      sections: [
        { topicId: null, title: '(全文)', level: 0, startLine: 0, endLine: lines.length - 1, text },
      ],
      unsegmented: true,
    };
  }

  const sections: Section[] = [];
  for (let k = 0; k < heads.length; k++) {
    const start = heads[k].i;
    const end = k + 1 < heads.length ? heads[k + 1].i - 1 : lines.length - 1;
    const body = lines.slice(start, end + 1).join('\n');
    if (body.trim().length < 2) continue;
    sections.push({
      topicId: heads[k].topicId,
      title: heads[k].title,
      level: heads[k].level,
      startLine: start,
      endLine: end,
      text: body,
    });
  }
  return { sections, unsegmented: false };
}

export interface LocateHit {
  /** 0 基行号，报告里 +1 显示 */
  line: number;
  snippet: string;
}

/**
 * 在指定行范围内找第一个命中，返回行号与摘录。
 * 调用方传带 g 的正则也安全——每次都重置 lastIndex。
 */
export function locate(
  lines: string[],
  re: RegExp,
  fromLine = 0,
  toLine = Number.MAX_SAFE_INTEGER,
): LocateHit | null {
  const end = Math.min(toLine, lines.length - 1);
  for (let i = Math.max(0, fromLine); i <= end; i++) {
    re.lastIndex = 0;
    const m = re.exec(lines[i]);
    if (m) {
      const idx = Math.max(0, (m.index ?? 0) - 20);
      return { line: i, snippet: lines[i].slice(idx, idx + 60).trim() };
    }
  }
  return null;
}

/** 便捷：整篇按行缓存，供多次 locate 复用 */
export interface BidDoc {
  path: string;
  text: string;
  lines: string[];
  sections: Section[];
  unsegmented: boolean;
  chars: number;
}

export function prepare(path: string, rules: HeadingRule[] = []): BidDoc {
  const raw = loadBidText(path);
  const text = normalize(raw);
  const lines = text.split('\n');
  const { sections, unsegmented } = splitSections(text, rules);
  return { path, text, lines, sections, unsegmented, chars: text.length };
}
