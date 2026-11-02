/**
 * 站点常量与分类规则。
 *
 * 分类设计说明：
 * - 站点自身只有 5 个粗分类（建筑/水利/交通/农业/其他），没有"电力""光伏""储能"，
 *   所以业务分类只能靠文本匹配。
 * - 关键难点是"配套词"：公告正文是长文档，污水处理厂、道路项目同样会写
 *   "临时用电""电缆敷设""输电线路""变电站"，这些是附属设施而不是项目主体。
 *   因此每条规则标注 kind：
 *     subject    —— 出现即代表项目本体（光伏电站、储能、房屋建筑、装饰装修）
 *     supporting —— 可能只是配套（输电线路、变压器、土建、临时用电）
 *   计分时配套词需要正文重复出现才采信，避免一处提及就误判。
 * - 一个公告可以同时命中多个类别（如"光伏电站升压站"既是光伏也是电力），
 *   tags 保留全部命中，primaryTag 按具体度取唯一值用于去重统计。
 */

export const SITE = {
  base: 'https://ggzy.ah.gov.cn',
  listPath: '/jsgc/list',
  detailPath: '/jsgc/newDetailSub',
  searchPath: '/souSuo',
} as const;

export const CRAWL = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  /** 实测该站约 1.5s 间隔稳定；更快会返回 1484 字节的错误页。 */
  delayMs: 1500,
  retries: 3,
  retryBackoffMs: 4000,
  timeoutMs: 40_000,
} as const;

/** 站点字段 tenderProjectType 取值。实测 A01..A10 等编码无效，仅这 5 个有效。 */
export const PROJECT_TYPES: Record<string, string> = {
  '1': '建筑工程',
  '2': '水利工程',
  '3': '交通工程',
  '4': '其他工程',
  '5': '农业工程',
};

/** 公告性质。1=招标公告，2=中标候选人公示，3=中标结果公告。 */
export const BULLETIN_NATURES: Record<string, string> = {
  '1': '招标公告',
  '2': '中标候选人公示',
  '3': '中标结果公告',
};

export type Tag = 'pv' | 'storage' | 'power' | 'building';

export const TAG_LABELS: Record<Tag, string> = {
  pv: '光伏',
  storage: '储能',
  power: '电力',
  building: '房建',
};

/** 具体度排序：越靠前越具体，用于从多标签中选 primaryTag。 */
export const TAG_PRIORITY: Tag[] = ['pv', 'storage', 'power', 'building'];

export type RuleKind = 'subject' | 'supporting';

export interface Rule {
  re: RegExp;
  weight: 1 | 2 | 3;
  kind: RuleKind;
  /** 命中后写进证据里给人工复核看的词。 */
  label: string;
}

export const CLASSIFY_RULES: Record<Tag, Rule[]> = {
  pv: [
    { re: /光伏/u, weight: 3, kind: 'subject', label: '光伏' },
    { re: /(农光|渔光|林光|牧光|风光)互补/u, weight: 3, kind: 'subject', label: '互补电站' },
    { re: /分布式光伏|屋顶光伏|光伏电站|光伏发电/u, weight: 3, kind: 'subject', label: '光伏电站' },
    { re: /光伏组件|光伏支架|光伏逆变器|逆变器/u, weight: 2, kind: 'supporting', label: '光伏设备' },
    { re: /单晶硅|多晶硅|硅片|电池片/u, weight: 2, kind: 'supporting', label: '硅材料' },
    { re: /光储(充|一体化)?/u, weight: 2, kind: 'subject', label: '光储' },
  ],
  storage: [
    { re: /储能/u, weight: 3, kind: 'subject', label: '储能' },
    { re: /抽水蓄能/u, weight: 3, kind: 'subject', label: '抽水蓄能' },
    { re: /电化学储能|电池储能|飞轮储能|压缩空气储能|液流电池/u, weight: 3, kind: 'subject', label: '储能类型' },
    { re: /储能电站|储能系统|储能电池|储能柜|储能单元/u, weight: 3, kind: 'subject', label: '储能设施' },
    { re: /共享储能|独立储能|新能源配储/u, weight: 3, kind: 'subject', label: '储能模式' },
  ],
  power: [
    { re: /输变电工程|送变电工程|电力工程|变电工程/u, weight: 3, kind: 'subject', label: '电力工程' },
    // "配电工程"不专指电力项目：高标准农田、灌区、厂区都会写"输配电工程"作为配套，
    // 因此只当标题命中或正文重复出现时采信。
    { re: /配电工程/u, weight: 2, kind: 'supporting', label: '配电工程' },
    // "10kV / 220kV"这类电压等级是电力项目独有的，房建、市政不会在项目概况里写。
    // 排除 kVA（变压器容量单位，不是电压），否则 "18300kVA" 会被当成 18300kV。
    { re: /\d+(?:\.\d+)?\s*[kK][vV](?![aA])/u, weight: 3, kind: 'subject', label: '电压等级' },
    // "供配电"作主体词；"变配电室/间"常是房建配套，不单独立项（详见下方 supporting）
    { re: /供配电/u, weight: 3, kind: 'subject', label: '供配电' },
    { re: /变电站|变电所|开关站|升压站|开闭所|汇流站/u, weight: 3, kind: 'supporting', label: '变电设施' },
    { re: /配电网|输电线路|电力线路|架空线路/u, weight: 2, kind: 'supporting', label: '线路工程' },
    { re: /发电工程|燃煤发电|燃气发电|水力发电|风力发电|风电|核电|生物质发电/u, weight: 3, kind: 'subject', label: '发电工程' },
    { re: /发电机组|汽轮机|余热锅炉/u, weight: 2, kind: 'supporting', label: '发电设备' },
    { re: /变压器|高压配电|低压配电|环网柜|箱式变/u, weight: 1, kind: 'supporting', label: '配电设备' },
    { re: /配电房|变配电室/u, weight: 2, kind: 'supporting', label: '配电房' },
    { re: /电缆敷设|临时用电|电力增容|用电报装/u, weight: 1, kind: 'supporting', label: '用电配套' },
    { re: /电网|供电公司/u, weight: 1, kind: 'supporting', label: '电网' },
  ],
  building: [
    // 不用"建筑工程施工"：它在招标范围、资格要求里到处出现，文旅、道路项目也这么写。
    { re: /房屋建筑|房建工程/u, weight: 3, kind: 'subject', label: '房屋建筑' },
    // 很多公告不写"房屋建筑"，只写"总建筑面积 X 平方米"。道路、水利项目不会用这个词，
    // 所以"建筑面积"是房建最可靠的单一信号。
    { re: /建筑面积/u, weight: 3, kind: 'subject', label: '建筑面积' },
    {
      re: /住宅楼|公寓楼|宿舍楼|办公楼|综合楼|教学楼|实验楼|图书馆|体育馆|活动中心/u,
      weight: 3,
      kind: 'subject',
      label: '民用建筑',
    },
    { re: /门诊楼|病房楼|住院楼|医技楼|疾控中心|卫生院/u, weight: 3, kind: 'subject', label: '医疗建筑' },
    // "用房"是房建的明确信号："输变电工区用房"虽然带输变电字样，但主体是房屋。
    { re: /用房/u, weight: 3, kind: 'subject', label: '用房' },
    { re: /装饰装修|装饰工程|精装修|室内装修|幕墙|外立面改造|装修改造/u, weight: 3, kind: 'subject', label: '装饰装修' },
    // "老旧小区改造"常写作"老旧小区整治改造""老旧小区提升改造"，中间允许插入几个字
    { re: /安置房|保障房|棚户区改造|老旧小区.{0,4}改造|危房改造/u, weight: 3, kind: 'subject', label: '住房改造' },
    { re: /厂房|钢结构工程/u, weight: 2, kind: 'subject', label: '工业建筑' },
    // "车间"单独出现多为附属（如污水厂的污泥脱水车间），不作主体信号
    { re: /车间/u, weight: 1, kind: 'supporting', label: '车间' },
    { re: /仓库|库房/u, weight: 1, kind: 'supporting', label: '仓储' },
    { re: /基坑支护|桩基工程|人防工程|地下车库/u, weight: 2, kind: 'supporting', label: '结构工程' },
    { re: /电梯(采购|安装|更换)/u, weight: 1, kind: 'supporting', label: '电梯' },
    // 弱信号：市政、水利项目同样会写"土建""主体结构"，只能靠重复出现才采信。
    { re: /土建工程|主体结构|混凝土结构/u, weight: 1, kind: 'supporting', label: '土建' },
  ],
};

/** 归类阈值。 */
export const SCORE_THRESHOLD = 4;

/** 标题命中倍率：标题最能代表项目本体，给高权重。 */
export const TITLE_MULTIPLIER = 3;

/** 正文命中倍率。subject 词命中一次即可，supporting 词需要重复出现。 */
export const BODY_MULTIPLIER = 2;

/** supporting 词在正文中至少出现这么多次才计入，避免配套描述造成误判。 */
export const SUPPORTING_MIN_OCCURRENCES = 2;
