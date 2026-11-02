/**
 * 抓取安徽省地方标准（DB34）完整目录。
 *
 * 数据源：全国标准信息公共服务平台 地方标准备案库
 *   POST https://dbba.sacinfo.org.cn/stdQueryList
 *   Content-Type: application/x-www-form-urlencoded
 *   参数：key=DB34 & current=页码 & size=每页条数
 *   返回：{ total, records: [{ code, chName, status, issueDate, actDate, chargeDept, industry, recordNo, pk }] }
 *
 * 踩坑记录：
 *   - 页面 /stdList 是 JS 渲染，HTML 里没有任何标准号
 *   - 真实接口藏在 bootstrap-table 的 url 配置里
 *   - 分页参数名不是 pageNumber/pageSize，也不是 offset/limit——
 *     而是 bootstrap-table 的 queryParams 函数映射后的 current/size。
 *     试错代价：pageNumber/page/offset/pageNo/pageIndex/start 全部无效，恒返回第 1 页
 *   - 不传 key 时 total=118153（全国全量）；key=DB34 时 total=5651
 *   - size 上限至少 100（5651 条 57 页跑完约 2 分钟）
 *   - 日期是毫秒时间戳，需要转换
 *
 * 用法：node --no-warnings src/db34-standards.ts [--pages=N] [--from=N]
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { request } from './fetch/http.ts';

const DATA = 'data';
const URL = 'https://dbba.sacinfo.org.cn/stdQueryList';
const KEY = 'DB34';

const argOf = (k: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : undefined;
};

interface Rec {
  code: string;
  chName: string;
  status: string;
  issueDate: number | null;
  actDate: number | null;
  chargeDept: string | null;
  industry: string | null;
  recordNo: string | null;
  pk: string;
}

const db = new DatabaseSync(join(DATA, 'index.db'));
db.exec('PRAGMA busy_timeout = 30000;');
db.exec(`
CREATE TABLE IF NOT EXISTS db34_standard (
  pk            TEXT PRIMARY KEY,   -- 备案库主键（可用于详情页 /stdDetail/<pk>）
  code          TEXT NOT NULL,      -- 标准号 DB34/T xxxx-yyyy
  name          TEXT NOT NULL,
  status        TEXT,               -- 现行 / 有更新版 / 废止
  issue_date    TEXT,               -- 发布日期
  act_date      TEXT,               -- 实施日期
  charge_dept   TEXT,               -- 主管部门
  industry      TEXT,               -- 行业/地域
  record_no     TEXT,               -- 备案号
  is_construction INTEGER NOT NULL DEFAULT 0,  -- 1 = 工程建设相关（按名称关键词判定）
  fetched_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_db34_code ON db34_standard(code);
CREATE INDEX IF NOT EXISTS idx_db34_constr ON db34_standard(is_construction);
`);

/** 工程建设相关关键词——用于从 5651 条里筛出技术标可能用到的部分 */
const CONSTRUCTION_KW = [
  '建筑', '施工', '工程', '验收', '结构', '混凝土', '砌体', '钢', '桩', '地基', '基坑',
  '防水', '保温', '幕墙', '装饰', '装修', '屋面', '门窗', '模板', '脚手架',
  '道路', '桥梁', '隧道', '市政', '管线', '管道', '给水', '排水', '燃气', '供热', '园林', '绿化',
  '水利', '堤防', '河道', '水库', '泵站',
  '电气', '电缆', '配电', '照明', '防雷', '接地',
  '装配式', '预制', '绿色建筑', '节能', '智慧工地', 'BIM', '工地',
];

/**
 * 排除词：这些领域虽然也含「质量/检测/工程」等字，但不是工程建设标准。
 * 踩过的坑：只靠 CONSTRUCTION_KW 匹配时，「地理标志产品质量要求」「保健食品质量管理」
 * 等农业/食品/医疗标准被误判为工程建设类（实测误报 200+ 条）。
 */
const EXCLUDE_KW = [
  '地理标志', '农产品', '食品', '保健', '医疗器械', '药物', '临床', '白酒', '茶',
  '葡萄', '辣椒', '黄精', '油茶', '核桃', '绞瓜', '柳编', '麻黄鸡', '脆桃', '猕猴桃',
  '果树', '果实', '畜禽', '养殖', '种植', '种子', '肥料', '饲料', '农药', '烟草',
  '蚕', '蜂', '菌', '粮', '油料', '蔬菜', '水果', '中药材', '医疗', '卫生', '养老',
  '预制菜', '纤维制品', '冷链物流', '追溯', '学生用', '供餐', '餐饮', '家政', '旅游',
];

const isConstruction = (name: string): boolean =>
  !EXCLUDE_KW.some((k) => name.includes(k)) && CONSTRUCTION_KW.some((k) => name.includes(k));

const post = async (current: number, size: number): Promise<{ total: number; records: Rec[] }> => {
  const r = await request(URL, {
    method: 'POST',
    body: `key=${KEY}&current=${current}&size=${size}`,
    extraHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeoutMs: 30000,
  });
  const j = JSON.parse(r.text) as { total: number; records: Rec[] };
  return { total: j.total, records: j.records ?? [] };
};

const d = (ts: number | null): string | null => (ts ? new Date(ts).toISOString().slice(0, 10) : null);

const ins = db.prepare(`
INSERT INTO db34_standard (pk, code, name, status, issue_date, act_date, charge_dept, industry, record_no, is_construction, fetched_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(pk) DO UPDATE SET
  code=excluded.code, name=excluded.name, status=excluded.status, issue_date=excluded.issue_date,
  act_date=excluded.act_date, charge_dept=excluded.charge_dept, industry=excluded.industry,
  record_no=excluded.record_no, is_construction=excluded.is_construction, fetched_at=excluded.fetched_at`);

// 先探一次，确定服务端实际的单页返回条数与总量
const PAGE_SIZE = 100;
const first = await post(1, PAGE_SIZE);
const cap = first.records.length || 10;
const total = first.total;
const totalPages = Math.ceil(total / cap);
const from = Number(argOf('from') ?? 1);
const to = Math.min(Number(argOf('pages') ?? totalPages), totalPages);

console.log(`DB34 共 ${total} 条，单页 ${cap} 条，共 ${totalPages} 页；本次抓 ${from}~${to}`);

let saved = 0;
let constr = 0;
const t0 = Date.now();

for (let page = from; page <= to; page++) {
  try {
    const { records } = page === 1 ? first : await post(page, cap);
    for (const r of records) {
      const c = isConstruction(r.chName ?? '');
      ins.run(
        r.pk,
        r.code,
        r.chName,
        r.status,
        d(r.issueDate),
        d(r.actDate),
        r.chargeDept,
        r.industry,
        r.recordNo,
        c ? 1 : 0,
        new Date().toISOString(),
      );
      saved++;
      if (c) constr++;
    }
    if (page % 20 === 0 || page === to) {
      console.log(`  第 ${page}/${to} 页，累计 ${saved} 条（工程建设相关 ${constr}）`);
    }
  } catch (e) {
    console.log(`  第 ${page} 页失败：${String(e).slice(0, 80)}`);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n完成：入库 ${saved} 条，其中工程建设相关 ${constr} 条；耗时 ${secs}s`);

const stat = db
  .prepare(
    `SELECT COUNT(*) n, SUM(is_construction) c, COUNT(DISTINCT code) codes FROM db34_standard`,
  )
  .get() as { n: number; c: number; codes: number };
console.log(`库里累计：${stat.n} 条 / 去重标准号 ${stat.codes} 个 / 工程建设相关 ${stat.c}`);
const byStatus = db
  .prepare('SELECT status, COUNT(*) n FROM db34_standard WHERE is_construction=1 GROUP BY status')
  .all() as Array<{ status: string; n: number }>;
console.log(`工程建设类的状态分布：${byStatus.map((x) => `${x.status ?? '?'}=${x.n}`).join('  ')}`);
db.close();
