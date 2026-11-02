/**
 * 按项目类型生成技术标「编制依据」章节。
 *
 * 标准库目前只是数据，这个脚本把它变成能直接粘贴进技术标的文本。
 *
 * 输出结构（技术标评审习惯的写法）：
 *   一、法律法规及规范性文件
 *   二、工程建设强制性规范（全文强制 GB 55xxx）  ← 评委重点看有没有漏
 *   三、国家标准（GB / GB/T）
 *   四、行业标准（JGJ / CJJ / SL）
 *   五、地方标准（DB34 安徽）
 *   六、招标文件及设计文件
 *
 * 排序依据 standard_project.priority：
 *   P1 专业标准（写这类标必须首先引）
 *   P2 施工通用（质量/安全/施工组织设计/危大工程）
 *   P3 间接相关（结构类通用规范、设计规范，按需引用）
 *
 * 用法：
 *   node --no-warnings src/tech-bid-standards.ts --type=房建
 *   node --no-warnings src/tech-bid-standards.ts --title="某工程施工总承包招标公告"
 *   node --no-warnings src/tech-bid-standards.ts --type=光伏 --out=output/光伏编制依据.md
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const DATA = 'data';
const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};

/**
 * 法律法规及规范性文件——技术标必备，但不在标准库（不是"标准"）。
 * 这是建筑类技术标的通行清单，各专业通用。
 */
const LAWS = [
  '《中华人民共和国建筑法》',
  '《中华人民共和国安全生产法》',
  '《中华人民共和国招标投标法》',
  '《中华人民共和国环境保护法》',
  '《建设工程质量管理条例》（国务院令第 279 号）',
  '《建设工程安全生产管理条例》（国务院令第 393 号）',
  '《安全生产许可证条例》（国务院令第 397 号）',
  '《房屋建筑和市政基础设施工程施工分包管理办法》',
  '《建筑业企业资质管理规定》',
  '《建设工程施工许可管理办法》',
];

/** 从公告标题识别项目类型——与 standard_project 的 project_type 保持一致 */
const TYPE_KW: Record<string, string[]> = {
  房建: [
    '房屋建筑', '住宅', '安置房', '学校', '校舍', '中学', '小学', '幼儿园', '大学', '学院',
    '医院', '门诊', '病房', '卫生院', '厂房', '仓库', '车间', '教学楼', '综合楼', '办公楼',
    '小区', '公寓', '宿舍', '食堂', '图书馆', '体育馆', '场馆', '孵化', '活动中心', '档案楼',
    '服务中心', '装饰', '装修', '幕墙', '钢结构', '楼', '馆', '老年公寓', '养老',
  ],
  市政: [
    '道路', '桥梁', '隧道', '市政', '管网', '排水', '污水', '供水', '燃气', '热力', '管廊',
    '路面', '路基', '顶管', '盾构', '照明', '硬化', '土地整治', '环卫', '垃圾', '停车场',
  ],
  园林: ['绿化', '园林', '景观', '公园', '苗木', '广场'],
  水利: [
    '水利', '河道', '水库', '防洪', '灌溉', '泵站', '堤防', '水闸', '航道', '疏浚',
    '农田', '灌区', '水土保持', '护坡', '除险加固',
  ],
  电力: ['供电', '输变电', '变电站', '配电', '线路工程', '升压站', '电力', '开关站'],
  光伏: ['光伏', '风电', '新能源', '储能', '充电桩', '太阳能'],
  智能化: ['智能化', '弱电', '信息化', '监控', '安防', '智慧', '数据中心', '系统集成'],
  老旧小区: ['老旧小区', '既有建筑', '改造', '加固', '维修', '维护', '修缮'],
  装配式: ['装配式', '预制', '模块化'],
};

const DB = new DatabaseSync(join(DATA, 'index.db'), { readOnly: true });

/**
 * 每类数量上限。
 * 实测房建项目能匹配 227 条（含 149 条地标），但真实技术标的编制依据章节
 * 通常只列 40~80 条——列太多会被认为“堆砌不精准”。
 * 排序规则：必备 > 常用 > 参考，同档按优先级与标准号。
 */
const LIMIT: Record<string, number> = { 国家标准: 40, 行业标准: 30, 地方标准: 20, 其他: 10 };

const RANK: Record<string, number> = { 必备: 0, 常用: 1, 参考: 2 };
const sortRows = (a: Row, b: Row): number =>
  (RANK[a.tech_bid_use] ?? 3) - (RANK[b.tech_bid_use] ?? 3) ||
  a.priority - b.priority ||
  a.code.localeCompare(b.code);

interface Row {
  code: string;
  name: string;
  level: string;
  status: string;
  mandatory_level: string;
  tech_bid_use: string;
  priority: number;
  verified: number;
}

const typeArg = argOf('type');
const titleArg = argOf('title');
const outArg = argOf('out');

let types: string[] = [];
if (typeArg) {
  types = [typeArg];
} else if (titleArg) {
  // 一个公告可能同时命中多个类型（例如"光伏发电站配套道路"），取全部
  for (const [t, kws] of Object.entries(TYPE_KW)) {
    if (kws.some((k) => titleArg.includes(k))) types.push(t);
  }
}
if (!types.length) {
  if (titleArg) {
    console.log(`未能从标题识别项目类型：「${titleArg}」`);
    console.log(`请用 --type= 手动指定，可用：${Object.keys(TYPE_KW).join(' / ')}`);
  } else {
    console.log('用法：');
    console.log('  node src/tech-bid-standards.ts --type=房建');
    console.log('  node src/tech-bid-standards.ts --title="某工程施工总承包招标公告"');
    console.log(`\n可用类型：${Object.keys(TYPE_KW).join(' / ')}`);
  }
  process.exit(1);
}

// 多类型时取并集（同一标准只出现一次，取最高优先级）
const rowsAll = new Map<string, Row>();
for (const t of types) {
  const rs = DB.prepare(
    `SELECT s.code, s.name, s.level, s.status, COALESCE(s.mandatory_level,'') mandatory_level,
            s.tech_bid_use, m.priority, s.verified
     FROM standard_project m JOIN standard_ref s ON s.code = m.std_code
     WHERE m.project_type = ? AND s.status = '现行'`,
  ).all(t) as Row[];
  for (const r of rs) {
    const prev = rowsAll.get(r.code);
    if (!prev || r.priority < prev.priority) rowsAll.set(r.code, r);
  }
}
DB.close();

const all = [...rowsAll.values()];

// 分组
const mandatory = all.filter((r) => r.mandatory_level === '全文强制').sort((a, b) => a.code.localeCompare(b.code));
const nationalAll = all.filter((r) => r.mandatory_level !== '全文强制' && r.level === '国家标准').sort(sortRows);
const industryAll = all.filter((r) => r.level === '行业标准').sort(sortRows);
const localAll = all.filter((r) => r.level === '地方标准').sort(sortRows);
const otherAll = all.filter((r) => !['国家标准', '行业标准', '地方标准'].includes(r.level)).sort(sortRows);

const national = nationalAll.slice(0, LIMIT['国家标准']);
const industry = industryAll.slice(0, LIMIT['行业标准']);
const local = localAll.slice(0, LIMIT['地方标准']);
const other = otherAll.slice(0, LIMIT['其他']);

const line = (r: Row, i: number): string =>
  `| ${i} | 《${r.name}》 | ${r.code} | ${r.tech_bid_use}${r.verified ? '' : ' ⚠待核'} |`;

const out: string[] = [];
out.push(`# 编制依据`);
out.push('');
out.push(`> 项目类型：${types.join(' + ')}${titleArg ? `｜来源：${titleArg}` : ''}`);
out.push(`> 生成时间：${new Date().toISOString().slice(0, 10)}｜标准库版本：standard_ref ${all.length} 条匹配`);
out.push('');

out.push(`## 一、法律法规及规范性文件`);
out.push('');
LAWS.forEach((l, i) => out.push(`${i + 1}. ${l}`));
out.push('');

out.push(`## 二、工程建设强制性规范（全文强制，必须执行）`);
out.push('');
out.push(`本工程执行的强制性工程建设规范共 ${mandatory.length} 条，全部条文必须严格执行。`);
out.push('');
if (mandatory.length) {
  out.push('| 序号 | 标准名称 | 标准号 |');
  out.push('|---|---|---|');
  mandatory.forEach((r, i) => out.push(`| ${i + 1} | 《${r.name}》 | ${r.code} |`));
} else {
  out.push('（本项目类型无对应全文强制规范）');
}
out.push('');

// 编号存疑的标准单独提醒——宁可提醒也不能默默引错
const unverified = all.filter((r) => !r.verified);
if (unverified.length) {
  out.push(`> ⚠ 下列 ${unverified.length} 条标准尚未完成交叉验证，引用前必须复核：${unverified.map((r) => r.code).join('、')}`);
  out.push('');
}

const section = (title: string, rows: Row[], note: string, total: number): void => {
  out.push(`## ${title}`);
  out.push('');
  if (!rows.length) {
    out.push('（无）');
    out.push('');
    return;
  }
  const noteText = total > rows.length ? `${note}（库内共 ${total} 条，此处列出最相关的 ${rows.length} 条）` : note;
  if (noteText) {
    out.push(noteText);
    out.push('');
  }
  out.push('| 序号 | 标准名称 | 标准号 | 用途 |');
  out.push('|---|---|---|---|');
  rows.forEach((r, i) => out.push(line(r, i + 1)));
  out.push('');
};

section('三、国家标准', national, '执行国家现行标准，均采用最新版本：', nationalAll.length);
section('四、行业标准', industry, '执行行业现行标准：', industryAll.length);
section('五、地方标准（安徽省）', local, '执行安徽省工程建设地方标准：', localAll.length);
if (other.length) section('六、其他规范性文件', other, '', otherAll.length);

out.push(`## ${other.length ? '七' : '六'}、招标文件及设计文件`);
out.push('');
out.push('1. 本工程招标文件及答疑澄清文件；');
out.push('2. 本工程施工图纸及设计说明；');
out.push('3. 本工程地质勘察报告；');
out.push('4. 招标文件中明确的其他技术要求。');
out.push('');
out.push('---');
out.push('');
out.push('> 说明：上述标准如实施过程中发布新版本，按新版本执行；');
out.push('> 招标文件技术要求高于上述标准的，按招标文件执行。');

const text = out.join('\n');

if (outArg) {
  const dir = outArg.includes('/') ? outArg.slice(0, outArg.lastIndexOf('/')) : '.';
  mkdirSync(dir, { recursive: true });
  writeFileSync(outArg, text, 'utf8');
  console.log(`已生成：${outArg}`);
} else {
  console.log(text);
}

console.error(
  `\n[统计] 类型=${types.join('+')} 强制=${mandatory.length} 国标=${national.length} 行标=${industry.length} 地标=${local.length} 其他=${other.length} 合计=${all.length}`,
);
