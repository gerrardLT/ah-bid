# ah-bid 使用说明

安徽省招投标数据底座 + 技术标材料生成器。

## 快速开始

```bash
cd D:\project\ah-bid

# 给一个项目名，一次出全套材料包
node --no-warnings src/tech-bid.ts --title="铜陵市义安区2026年学前教育"
```

输出到 `output/<项目名>/`：

```
README.md          总览：类型、分值构成、权重最高项、价格基准
01-编制依据.md      技术标「编制依据」章节（可直接粘贴）
02-评分拆解.md      分值构成 + 应标策略 + 废标风险点 + 评分细则
03-报价基准.md      同类中标价 + 下浮率参考
```

**找不到招标文件也能跑**——降级为只出 01 和 03，不报错。

## 生成器与解析器

### 输出类（给项目名，出文档）

| 脚本 | 用途 | 常用参数 |
|---|---|---|
| `tech-bid.ts` | **一键编排**（推荐入口） | `--title="项目名"` `--out=目录` `--caliber=limit｜estimate｜mixed` |
| `tech-bid-standards.ts` | 编制依据章节 | `--type=房建` 或 `--title=` `--out=` |
| `tech-bid-scoring.ts` | 评分拆解（含澄清变更） | `--guid=<attach_guid>` 或 `--title=` `--out=` |
| `scoring-hotspots.ts` | 高频评分点统计 | `--top=40` `--out=` |
| `price-benchmark.ts` | 中标价基准表 | `--out=` |
| `price-benchmark-power.py` | 供电工程报价基准（物料单价） | `--out=` |
| `control-price.ts` | 控制价入库 | — |

### 解析类（处理私有数据 D:\bid-info）

| 脚本 | 输入 | 产出 |
|---|---|---|
| `bid-boq.py` | Excel 清单（.xls/.xlsx） | `bid_boq_item` 17,607 条（量，无价） |
| `bid-boq-price.py` | 带价控制价 Excel | `bid_boq_price` 390 条（量+价） |
| `bid-boq-xml.py` | 广联达 XML（.18zhzb） | `bid_boq_xml` 1,240 条（量+计算规则）、`bid_boq_measure` 53 项费率 |
| `build-boq-view.py` | 上述四张表 | 三个统一视图 `v_boq_all` / `v_boq_merged` / `v_boq_stat` |
| `clarification-qa.py` | 澄清 PDF | `clarification_qa` 6,544 条问答 |

### 单独用某个生成器

```bash
# 只出编制依据（9 种类型可选：房建/市政/园林/水利/电力/光伏/智能化/老旧小区/装配式）
node --no-warnings src/tech-bid-standards.ts --type=光伏 --out=output/光伏编制依据.md

# 从招标公告标题自动识别类型
node --no-warnings src/tech-bid-standards.ts --title="某县校舍安全工程项目"

# 只出评分拆解
node --no-warnings src/tech-bid-scoring.ts --title="安置房EPC改造" --out=output/评分拆解.md

# 重新统计高频榜（数据变了才需要跑，约 1 分钟）
node --no-warnings src/scoring-hotspots.ts --top=40 --out=output/高频评分点统计.md

# 重新算中标价基准（约 20 秒）
node --no-warnings src/price-benchmark.ts --out=output/中标价基准表.md
```

## 数据生产（一般不用跑）

已有的数据不动就别重跑，这些都是几十分钟到几小时的任务。

```bash
# 1. 附件下载（断点续跑）
node --no-warnings src/attach.ts --nature=1 --only-missing

# 2. 招标文件解析（分批跑，长任务容易中断）
node --no-warnings src/extract-docs.ts --all
node --no-warnings src/extract-docs.ts --limit=400 --from=400 --redo

# 3. 中标结果提取
node --no-warnings src/extract-bids-from-body.ts     # 从公告正文（主力，约 1 分钟）
node --no-warnings src/extract-bids.ts --all         # 从附件（跑完自动 join）

# 4. 履约信息
node --no-warnings src/performance.ts --pages=100 --from=63

# 5. 标准库重建（改完 data/standards.json 后跑）
node --no-warnings src/rebuild-standards.ts
```

## 关键数据表

| 表 | 行数 | 说明 |
|---|---|---|
| `announcement` | 22,272 | 公告主表（nature: 1=招标 2/3=中标） |
| `attachment` | 10,705 | 附件（26.96 GB，SHA-256 已全量校验） |
| `tender_doc` | 1,982 | 招标文件解析结果（评标办法 + 四维分值） |
| `scoring_item` | 127,587 | 评分表逐行（三形态：表格/跨页续行/段落） |
| `bid_result` | 780 | 中标结果（附件来源，181 条有价） |
| `bid_body_result` | 4,269 | 中标结果（正文来源，3,249 条有价，其中 high 2,559） |
| `tender_price_raw` | 7,352 | 公告正文价格原文（限价 1,438 / 估算 5,914） |
| `tender_buyer` | 8,188 | 招标人 / 代理机构 |
| `tender_duration` | 7,899 | 工期候选（均值 252 天） |
| `tender_control_price` | 1,812 | 招标控制价（真限价 1,282，其余为估算价/预算） |
| `performance_record` | 890 | 履约信息（176 亿） |
| `standard_ref` | 505 | 标准库（99.8% 交叉验证） |
| `db34_standard` | 5,651 | 安徽地方标准全量 |
| `standard_project` | 803 | 标准↔项目类型映射（含 priority） |
| `standard_research` | 64 | 调研发现（全部定论，0 存疑） |

### 清单数据（私有，四种来源）

| 表 | 行数 | 有量 | 有价 | 有计算规则 | 有费率 | 说明 |
|---|---|---|---|---|---|---|
| `bid_boq_item` | 17,803 | ✓ | — | — | — | Excel 清单（14 个项目） |
| `bid_boq_price` | 463 | ✓ | ✓ | — | — | 控制价里的带价清单（6 个项目） |
| `bid_boq_xml` | 1,240 | ✓ | — | ✓ | — | 广联达 XML 清单（4 个项目） |
| `bid_boq_measure` | 53 | — | — | — | ✓ | 措施项目费率 |
| `bid_control_price` | 7 | — | ✓ | — | — | 项目控制价总额 |

### 三个统一视图

| 视图 | 行数 | 用途 |
|---|---|---|
| `v_boq_all` | 19,506 | **全部行**，带 `src` 标记（excel/xml/price），用于追溯来源 |
| `v_boq_merged` | 19,334 | **同文件内去重**，保留单体/标段维度，日常查询用这个 |
| `v_boq_stat` | 8,086 | **按项目+编码聚合**（数量 SUM、单价 AVG），分析用 |

**关键区分**：

```
v_boq_merged  一条 = 某个单体里的一项清单
              1#教学楼 010101001001 平整场地 282 m²
              2#综合楼 010101001001 平整场地 156 m²
              → 两条，不能合并

v_boq_stat    一条 = 某项目里的一种清单编码
              010101001001 平整场地 合计 438 m²
              → 一条，数量已相加
```

### 清单查询示例

```sql
-- ① 某项目的全部清单（含单体维度）
SELECT code, name, unit, qty, category
FROM v_boq_merged WHERE project LIKE '%葛大店%' ORDER BY code;

-- ② 某类物料在各项目的用量与单价
SELECT project, name, qty_total, unit, price_avg, total_sum
FROM v_boq_stat
WHERE name LIKE '%电力电缆%' AND price_avg > 0
ORDER BY total_sum DESC;

-- ③ 有计算规则的清单（算量依据）
SELECT project, name, unit, qty_total, calc_rule
FROM v_boq_stat WHERE calc_rule <> '' LIMIT 20;

-- ④ 直接组价：量 × 单价
SELECT project, name, qty_total, unit, price_avg,
       ROUND(qty_total * price_avg, 2) AS amount
FROM v_boq_stat
WHERE qty_total > 0 AND price_avg > 0
ORDER BY amount DESC LIMIT 20;

-- ⑤ 措施费率（报价用）
SELECT project, name, rate, base FROM bid_boq_measure WHERE rate > 0;

-- ⑥ 追溯某条数据的来源
SELECT src, src_file, code, qty, price, calc_rule
FROM v_boq_all WHERE project = '…' AND code = '030408003001';
```

### 四类数据的真实分布

```
19,334 条清单
  ├ 17,803 条 只有工程量（Excel）
  ├  1,240 条 工程量 + 计算规则（XML）
  └    463 条 工程量 + 单价（控制价）

  三条全齐 = 0 条
  → 因为控制价项目（首都医科大/鸠江/赛仑特/马鞍山）
    和 XML 清单项目（合庐光伏/造甲/省委幼儿园/安庆光储充）
    零交集
```

**能直接组价的 463 条**（来自 6 个控制价文件，自洽校验 463/463 = 100%），且全是供电工程——所以报价基准只对供电类项目有效。

## 常用查询

```sql
-- 某项目类型的必引规范
SELECT s.code, s.name FROM standard_project m
JOIN standard_ref s ON s.code = m.std_code
WHERE m.project_type='光伏' AND s.mandatory_level='全文强制';

-- 某类项目的中标价分布
SELECT COUNT(*) n, ROUND(AVG(winner_price)/10000) avg_wan
FROM bid_body_result WHERE winner_price IS NOT NULL AND confidence='high';

-- 某标准的调研依据
SELECT finding, evidence FROM standard_research WHERE keyword LIKE '%CJJ 82%';
```

## 已知限制

| 限制 | 影响 | 现状 / 决策 |
|---|---|---|
| 中标价 3,249 条（high 2,559） | 无法覆盖全部中标公告 | 已是可获取上限 |
| 下浮率样本 410 条 | 够看趋势，不够单项目精算 | 全等匹配 + 多标段剔除，宁少不错 |
| 高频榜占比是下界 | "报价 37.4%" 实际更高 | 单份只提取到 2–4 处评分因素 |
| `detail_type` 错位 7,994 个 | 正文是招标公告内容 | **决策：不修**。20 个实测证明 URL 本指向招标公告页面，16/20 还是 JS 渲染空壳，含中标价 0 个 |
| 13 份“评分表 0 个” | 修复提取逻辑后已大幅减少 | 早期 239 份里 71% 是低价法/定性法，属业务本质 |
| 2 份矢量型 PDF | 文字转路径，需 OCR | 能力已备（`ocr_scoring.py`），但本就没评分表 |
| 履约信息 890 / 14.3 万 | 只有 0.6% | **决策：不做全量**。三达标全"合格"无区分度、结算额恒等于合同额、技术标要的是本公司业绩非此页面。仅作对手分析储备 |
| 4,648 个无标签公告缺附件 | — | 设计如此（只抓 nature=1 的四类标签） |
| 648 个防护城市公告缺附件 | 阜阳/安庆/淮南 | 需过验证码/JS 挑战，涉及合规判断，未做 |

## 排查思路

**"数据没提取到"和"数据不存在"是两件事，先分清。**

判断依据只有一个：**同一份文件，PDF 里有、库里没有 → 一定是代码问题**。

三步确认：
1. `page.get_text()` 有字吗 → 有字说明不是扫描件
2. `page.find_tables()` 有表吗 → 有表说明识别正常
3. 表头含关键词吗 → 含说明筛选逻辑该通过

三步都正常但库里没数据 → 查筛选/章节范围/入库逻辑，别上 OCR。

## 数据处理状态（全量审计）

### 公开数据（安徽公共资源交易平台）

| 数据源 | 总量 | 已处理 | 处理方式 | 未处理 |
|---|---|---|---|---|
| 公告 | 22,272 | 全部入库 | 标题/城市/发布日期/正文 | — |
| 附件 | 10,701 | 2,688 | 见下 | **8,013 个 PDF** |
| └ 招标文件 PDF | 1,982 | 全部 | PyMuPDF 抽章节 + 评分表 + 澄清问答 | — |
| └ 澄清 PDF | 706 | 全部 | 抽问答对 → `clarification_qa` | — |
| └ .SZZF 专有格式 | 152 | **0** | — | **未解析** |
| └ .zip 压缩包 | 514 | 0 | 只读目录列表，不解压 | **未解压** |
| └ 其他 PDF | ≈8,013 | **0** | — | **合同/中标公示/图纸未读** |

**已提取的结构化数据**：

```
tender_doc          1,982 份 → 评分表 127,587 行
clarification_qa    6,544 条 → 覆盖 462 个公告
bid_body_result     4,269 条（有价 3,249）
bid_result            780 条（有价   181）
tender_control_price 1,812 条（真限价 1,282）
performance_record     890 条（站点 14.3 万，抓了 0.6%）
standard_ref           505 条 + db34 5,651 条
standard_research       64 条
```

### 私有数据（D:\bid-info）

27 个项目 zip，嵌套解压后 **725 个文件**：

| 格式 | 数量 | 已处理 | 处理方式 |
|---|---|---|---|
| .dwg 图纸 | 241 | **0** | 未处理（需 CAD 解析） |
| .xls / .xlsx 清单 | 241 | 185 | xlrd/openpyxl → 17,607 条无价 + 390 条带价 |
| .pdf | 94 | **0** | 未处理（招标文件/图纸/编制说明） |
| .doc / .docx | 60 | 1 | 仅读过一份“工程量清单总说明” |
| .rar | 20 | 7 | 7-Zip 解压（含控制价/清单类），13 个未解（图纸包/分卷） |
| 专有格式 | 129 | **0** | 未解析（.hfzf/.18whzf/.aqzf 等 8 种） |

**产出**：`bid_boq_item` 17,607 条｜`bid_boq_price` 390 条｜`bid_control_price` 7 个项目

### 一句话总结

**公开数据榨干了“评分规则”和“价格分布”，私有数据榨干了“清单”。**

**没碰的三大块**：图纸（241 + 1 个 dwg）、专有格式（281 个）、公开数据里的 8,013 个 PDF（主要是合同与中标公示）。

## 目录

```
src/              源码（TS 为主，PDF 解析用 Python）
src/lib/          共享算法（下浮率统计的唯一实现：口径/匹配/去重/分位）
data/index.db     主库（SQLite）
data/standards.json          标准库源文件（手工维护）
data/standards-research.json 调研发现源文件
data/attachments/  附件（26.96 GB，按城市/年月/guid 分层）
output/           生成的材料包与文档
```
