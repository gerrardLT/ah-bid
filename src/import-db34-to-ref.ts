/**
 * 把 db34_standard 里的工程建设类标准并入 standard_ref，并建立项目类型映射。
 *
 * 为什么并进 standard_ref：两类标准（国标/行标 + 地方标准）如果分表存，
 * 写技术标时要查两次、排序也只能各自排。并进同一张表后，
 * 「某类项目该引哪些标准」一条 SQL 就能拿到国标 + 省标的完整清单。
 *
 * 只并入「现行」和「有更新版」：废止的不该出现在推荐清单里，
 * 但保留在 db34_standard 里供校验"是否引了废止标准"。
 *
 * 手工维护的 14 条 DB34（有 note 说明）不会被覆盖。
 *
 * 用法：node --no-warnings src/import-db34-to-ref.ts
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const DATA = 'data';

/**
 * 项目类型分类关键词。一条标准可命中多个类型
 * （例：「装配式混凝土桥梁连接技术规程」→ 装配式 + 市政）。
 */
const TYPE_KW: Record<string, string[]> = {
  房建: [
    '建筑', '房屋', '住宅', '混凝土', '砌体', '钢结构', '装饰', '装修', '幕墙', '屋面',
    '防水', '保温', '门窗', '模板', '脚手架', '地基', '桩', '基坑', '结构', '抗震',
    '隔墙', '楼板', '外墙', '内装', '抹灰', '涂饰', '地面',
  ],
  市政: [
    '道路', '桥梁', '隧道', '市政', '管线', '管道', '给水', '排水', '燃气', '供热',
    '照明', '管廊', '路面', '路基', '污水', '供水', '顶管', '盾构', '高速', '轨道交通',
    '沥青', '污废水', '零直排', '生命线',
  ],
  园林: ['园林', '绿化', '景观', '苗木', '公园', '种植'],
  水利: ['水利', '堤防', '河道', '水库', '泵站', '灌溉', '水土保持', '护岸', '防洪', '闸', '航道'],
  电力: ['电气', '电缆', '配电', '变电', '输电', '接地', '防雷', '电力', '架空', '开关站'],
  光伏: ['光伏', '太阳能', '新能源', '储能', '风电', '风力', '充电'],
  智能化: ['智能', '信息化', '监控', '安防', '弱电', '通信', '网络', '数据中心', 'BIM', '光网络', '物联', '生命线'],
  老旧小区: ['既有建筑', '改造', '加固', '节能改造', '维修', '排查'],
  装配式: ['装配式', '预制', '模块化', '构件', '叠合'],
};

/** 通用但确实描述工程建设的词——命中任一即归入房建（最大类，宁多勿漏） */
const FALLBACK_KW = [
  '安全生产', '标准化工地', '评价标准', '工地', '验收规范', '技术规程',
  '人防', '防空', '空调', '制冷', '机房', '工程监测', '工程抢险',
];

/** 判定一条标准属于哪些项目类型 */
function classify(name: string): string[] {
  const hit: string[] = [];
  for (const [type, kws] of Object.entries(TYPE_KW)) {
    if (kws.some((k) => name.includes(k))) hit.push(type);
  }
  // 通用但明确属于工程建设的（例：「建筑工程安全生产标准化工地评价标准」）
  // 专业词一个都没命中时兑底归入房建，否则会变成「无专业归属」
  if (hit.length === 0 && FALLBACK_KW.some((k) => name.includes(k))) hit.push('房建');
  return hit;
}

/** 技术标用途分级：带这些词的属于施工/验收/技术规程，属于「常用」；其余「参考」 */
const CORE_KW = ['施工', '验收', '技术规程', '技术标准', '质量', '检测', '检验', '评定'];
const isCore = (name: string): boolean => CORE_KW.some((k) => name.includes(k));

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');

// 0) 清理：用修正后的 is_construction 重新判后，已不再属于工程建设类的批量导入条目要删掉。
//    手工维护的条目（note 不以【批量导入】开头）不动。
const stale = db
  .prepare(
    `SELECT s.code FROM standard_ref s
     JOIN db34_standard d ON d.code = s.code
     WHERE s.category='安徽地方' AND s.note LIKE '%【批量导入%' AND d.is_construction = 0`,
  )
  .all() as Array<{ code: string }>;
const delMap = db.prepare('DELETE FROM standard_project WHERE std_code = ?');
const delRef = db.prepare('DELETE FROM standard_ref WHERE code = ?');
for (const s of stale) {
  delMap.run(s.code);
  delRef.run(s.code);
}
if (stale.length) console.log(`清理误判的非工程建设条目 ${stale.length} 条`);

const rows = db
  .prepare(
    `SELECT code, name, status, act_date FROM db34_standard
     WHERE is_construction = 1 AND status IN ('现行', '有更新版')
     ORDER BY act_date DESC`,
  )
  .all() as Array<{ code: string; name: string; status: string; act_date: string | null }>;

// note 已存在的（手工维护的 14 条）不覆盖
const up = db.prepare(`
INSERT INTO standard_ref (code, name, level, category, status, verified, sources, tech_bid_use, note, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(code) DO UPDATE SET
  name=excluded.name, level=excluded.level, category=excluded.category,
  status=excluded.status, verified=excluded.verified, sources=excluded.sources,
  tech_bid_use=excluded.tech_bid_use,
  note=CASE WHEN standard_ref.note LIKE '%【批量导入%' THEN excluded.note ELSE standard_ref.note END,
  updated_at=excluded.updated_at`);

const insMap = db.prepare('INSERT OR IGNORE INTO standard_project (project_type, std_code) VALUES (?,?)');
const existNote = db.prepare('SELECT note FROM standard_ref WHERE code = ?');

// 重算映射前先清掉 DB34 的旧映射：分类关键词会随调研修正而变，
// 用 INSERT OR IGNORE 会残留上一轮的误分类（实测：砌体验收规程因为早期归类残留，
// 一直出现在光伏清单里）。
db.exec(`DELETE FROM standard_project WHERE std_code IN (SELECT code FROM db34_standard)`);

const now = new Date().toISOString();
let imported = 0;
let mapped = 0;
let unclassified = 0;
const byType = new Map<string, number>();

for (const r of rows) {
  const types = classify(r.name);
  const use = isCore(r.name) ? '常用' : '参考';
  const prev = existNote.get(r.code) as { note: string | null } | undefined;

  up.run(
    r.code,
    r.name,
    '地方标准',
    '安徽地方',
    r.status,
    1, // verified：来源为官方备案库，视为可信
    1, // sources：官方备案库视为单一可信来源，标记为 1
    use,
    prev?.note ?? `【批量导入】安徽地方标准，${r.act_date ?? ''} 实施`,
    now,
  );
  imported++;

  if (types.length === 0) {
    unclassified++;
    continue;
  }
  for (const t of types) {
    insMap.run(t, r.code);
    mapped++;
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
}

console.log(`从 db34_standard 并入 ${imported} 条（现行 + 有更新版）`);
console.log(`建立映射 ${mapped} 条；无专业归属（仅通用）${unclassified} 条`);
console.log('\n各项目类型新增的 DB34 标准：');
for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(8)} ${n} 条`);

// 最终统计：每个项目类型能拿到多少条（国标 + 行标 + 省标）
console.log('\n各项目类型可用标准总数：');
for (const r of db
  .prepare(
    `SELECT m.project_type p, COUNT(*) n,
            SUM(CASE WHEN s.tech_bid_use='必备' THEN 1 ELSE 0 END) req,
            SUM(CASE WHEN s.level='地方标准' THEN 1 ELSE 0 END) local
     FROM standard_project m JOIN standard_ref s ON s.code=m.std_code
     GROUP BY p ORDER BY n DESC`,
  )
  .all() as Array<{ p: string; n: number; req: number; local: number }>) {
  console.log(`  ${r.p.padEnd(8)} ${String(r.n).padStart(3)} 条（必备 ${r.req}，省标 ${r.local}）`);
}

const t = db.prepare('SELECT COUNT(*) n FROM standard_ref').get() as { n: number };
const m = db.prepare('SELECT COUNT(*) n FROM standard_project').get() as { n: number };
console.log(`\nstandard_ref ${t.n} 条 / standard_project ${m.n} 条映射`);
db.close();
