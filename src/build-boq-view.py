"""把四种清单来源合并成统一视图。

四张表各有侧重，查询时容易搞混：
  bid_boq_item     17,607 条  Excel 清单，有量无价
  bid_boq_price       390 条  控制价清单，有量有价
  bid_boq_xml       1,240 条  XML 清单，有量+计算规则
  bid_boq_measure      53 项  措施项目费率（不是清单项，单独看）

建两个视图：
  v_boq_all     —— 全部行，带 src 标记（用于追溯来源）
  v_boq_merged  —— 按 (project, code) 去重，字段取各来源并集
                   qty 优先级：price(控制价) > xml > item
                   price / total 只有 price 来源有
                   calc_rule 只有 xml 来源有

用法：python src/build-boq-view.py
"""
import os, sys, sqlite3
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 路径基于脚本位置推导，换机器/换目录不用改代码
DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "index.db")
db = sqlite3.connect(DB)
db.execute("PRAGMA busy_timeout=30000")
cur = db.cursor()

cur.executescript("""
DROP VIEW IF EXISTS v_boq_all;
DROP VIEW IF EXISTS v_boq_merged;
DROP VIEW IF EXISTS v_boq_stat;

-- 全部行，带来源标记与来源文件
-- 注意：不能按 (project, code) 去重——同一编码在不同单体/标段里是不同的清单项
-- （1#楼和 2#楼的「平整场地」要分别算量）。所以保留 src_file 维度。
CREATE VIEW v_boq_all AS
SELECT project, 'excel' AS src, file AS src_file, code, name, feature, unit, qty,
       NULL AS price, NULL AS total, NULL AS calc_rule, category
  FROM bid_boq_item
UNION ALL
SELECT project, 'price' AS src, file AS src_file, code, name, feature, unit, qty,
       price, total, NULL AS calc_rule, category
  FROM bid_boq_price
UNION ALL
SELECT project, 'xml' AS src, file AS src_file, code, name, feature, unit, qty,
       NULL AS price, NULL AS total, calc_rule, category
  FROM bid_boq_xml;

-- 按 (project, src_file, code) 去重：这才是同一个清单项
CREATE VIEW v_boq_merged AS
SELECT
  project, src, src_file, code,
  MAX(name) AS name, MAX(feature) AS feature, MAX(unit) AS unit, MAX(category) AS category,
  MAX(qty) AS qty, MAX(price) AS price, MAX(total) AS total,
  MAX(calc_rule) AS calc_rule,
  COUNT(*) AS dup_rows
FROM v_boq_all
GROUP BY project, src, src_file, code;

-- 分析用：按 (project, code) 聚合汇总（数量相加、单价取均值）
CREATE VIEW v_boq_stat AS
SELECT
  project, code,
  MAX(name) AS name, MAX(unit) AS unit,
  ROUND(SUM(qty), 2) AS qty_total,
  COUNT(DISTINCT src_file) AS file_cnt,
  ROUND(AVG(price), 2) AS price_avg,
  ROUND(MAX(price), 2) AS price_max,
  ROUND(MIN(price), 2) AS price_min,
  ROUND(SUM(total), 2) AS total_sum,
  MAX(calc_rule) AS calc_rule,
  GROUP_CONCAT(DISTINCT src) AS sources
FROM v_boq_all
GROUP BY project, code;
""")
db.commit()

print("视图已创建\n")

def q(sql, *a):
    return cur.execute(sql, a).fetchall()

print("=== v_boq_all（全部行）===")
for r in q("SELECT src, COUNT(*) FROM v_boq_all GROUP BY src ORDER BY COUNT(*) DESC"):
    print(f"  {r[0]:<8} {r[1]:>6} 行")
print(f"  合计 {q('SELECT COUNT(*) FROM v_boq_all')[0][0]} 行\n")

print("=== v_boq_merged（同文件内去重）===")
n_all = q("SELECT COUNT(*) FROM v_boq_merged")[0][0]
n_qty = q("SELECT COUNT(*) FROM v_boq_merged WHERE qty IS NOT NULL")[0][0]
n_price = q("SELECT COUNT(*) FROM v_boq_merged WHERE price IS NOT NULL")[0][0]
n_rule = q("SELECT COUNT(*) FROM v_boq_merged WHERE calc_rule IS NOT NULL AND calc_rule<>''")[0][0]
print(f"  {n_all} 条清单（保留单体/标段维度）")
print(f"  有工程量   {n_qty}")
print(f"  有单价     {n_price}")
print(f"  有计算规则 {n_rule}")
print()
print("=== v_boq_stat（按项目+编码聚合，分析用）===")
n_stat = q("SELECT COUNT(*) FROM v_boq_stat")[0][0]
n_stat_price = q("SELECT COUNT(*) FROM v_boq_stat WHERE price_avg IS NOT NULL")[0][0]
n_stat_rule = q("SELECT COUNT(*) FROM v_boq_stat WHERE calc_rule IS NOT NULL AND calc_rule<>''")[0][0]
print(f"  {n_stat} 种清单编码")
print(f"  有均价     {n_stat_price}")
print(f"  有计算规则 {n_stat_rule}")
print()
print("  按来源组合（v_boq_all）:")
for r in q("SELECT src, COUNT(*) FROM v_boq_all GROUP BY src ORDER BY COUNT(*) DESC"):
    print(f"    {r[0]:<18} {r[1]:>6} 条")
print()
print("  按项目（前 8）：")
for r in q("""SELECT project, COUNT(*) n, SUM(CASE WHEN price_avg IS NOT NULL THEN 1 ELSE 0 END) p,
                     ROUND(SUM(total_sum)/10000,1) wan
              FROM v_boq_stat GROUP BY project ORDER BY COUNT(*) DESC LIMIT 8"""):
    print(f"    {r[0][:34]:<36} {r[1]:>5} 种编码  有价 {r[2]:>3}  合价 {r[3] or 0:>8} 万")

print(f"\n=== 同时有「量+单价」的清单（可直接组价）===")
rows = q("""SELECT project, name, unit, qty_total, price_avg, total_sum FROM v_boq_stat
            WHERE qty_total > 0 AND price_avg > 0 ORDER BY total_sum DESC LIMIT 8""")
if rows:
    for r in rows:
        print(f"  {r[0][:18]:<20} {r[1][:18]:<20} {r[3]:>8,.0f}{r[2]:<3} × {r[4]:>10,.2f} = {r[5] or 0:>12,.0f}")
else:
    print("  （无）")

db.close()
