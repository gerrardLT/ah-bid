"""解析控制价文件里的分部分项（带单价）→ bid_boq_price 表。

控制价文件 = 清单 + 价格，比单独的清单文件多两列（综合单价、合价）。
实测列映射（与清单文件不同，必须动态识别）：
  清单文件：  序号|编码|名称|特征|单位|工程量
  控制价文件：序号|编码|(空)|名称|特征|单位|(空)|工程量|综合单价|合价

自洽校验：工程量 × 综合单价 = 合价（鸠江 3152×243.30=766881.60 ✓）
"""
import sys, os, glob, re, sqlite3, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import xlrd, openpyxl

_DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DEST = os.path.join(_DATA, "bid-info", "control_price")
DB = os.path.join(_DATA, "index.db")
CODE12 = re.compile(r"^[0-9A-Za-z][0-9A-Za-z\-]{2,20}$")   # 兼容 12 位清单编码与定额编号（PL4-35 / PT1-63）

def cs(v):
    if v is None:
        return ""
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return re.sub(r"[\r\n\t]+", " ", str(v)).strip()

def fnum(v):
    if isinstance(v, (int, float)):
        return float(v)
    s = cs(v).replace(",", "").replace("，", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None

def read(fp):
    e = os.path.splitext(fp)[1].lower()
    try:
        if e == ".xls":
            wb = xlrd.open_workbook(fp)
            return [(s.name, [[s.cell_value(r, c) for c in range(s.ncols)] for r in range(s.nrows)]) for s in wb.sheets()]
        if e in (".xlsx", ".xlsm"):
            wb = openpyxl.load_workbook(fp, data_only=True, read_only=True)
            o = [(w.title, [list(r) for r in w.iter_rows(values_only=True)]) for w in wb.worksheets]
            wb.close()
            return o
    except Exception:
        return []
    return []

DIV = re.compile(r"分部分项|E\.?1", re.I)

def find_header(rows, limit=40):
    """返回 (行号, 列映射)。表头可能分两行（主表头 + 综合单价/合价）

    兼容两种列名（实测差异）：
      标准 E.1：项目编码 | 项目名称 | 项目特征 | 计量单位 | 工程量 | 综合单价 | 合价
      蜀山区式：编制依据 | 项目名称 |    （无）   |   单位   |  数量  |  单价   | 总价
    """
    for i, r in enumerate(rows[:limit]):
        txt = " ".join(cs(c) for c in r)
        if ("项目编码" in txt or "项目编号" in txt or "编制依据" in txt) and (
            "工程量" in txt or "计量单位" in txt or "数量" in txt
        ):
            col = {}
            for j, c in enumerate(r):
                s = re.sub(r"\s+", "", cs(c))
                if not s:
                    continue
                if "项目编码" in s or "项目编号" in s or "编制依据" in s:
                    col.setdefault("code", j)
                elif "项目名称" in s:
                    col.setdefault("name", j)
                elif "项目特征" in s:
                    col.setdefault("feature", j)
                elif "计量单位" in s or s == "单位":
                    col.setdefault("unit", j)
                elif ("工程量" in s or "数量" in s) and "单价" not in s:
                    col.setdefault("qty", j)
                elif s == "序号":
                    col.setdefault("seq", j)

            # 子表头（下一行）才是「综合单价」「合价」的真实位置
            if i + 1 < len(rows):
                for j, c in enumerate(rows[i + 1]):
                    s = re.sub(r"\s+", "", cs(c))
                    if not s:
                        continue
                    if "综合单价" in s or s.startswith("单价"):
                        col["price"] = j
                    elif "合价" in s or "总价" in s:
                        col["total"] = j
            # 主表头里已经写「单价（元）」「总价（元）」的（蜀山区式），直接取
            for j, c in enumerate(r):
                s = re.sub(r"\s+", "", cs(c))
                if s.startswith("单价") and "price" not in col:
                    col["price"] = j
                elif ("总价" in s or "合价" in s) and "total" not in col:
                    col["total"] = j

            if "code" in col and "qty" in col:
                return i, col
    return -1, {}

db = sqlite3.connect(DB)
db.execute("PRAGMA busy_timeout=30000")
db.executescript("""
CREATE TABLE IF NOT EXISTS bid_boq_price (
  project  TEXT NOT NULL,
  file     TEXT NOT NULL,
  sheet    TEXT NOT NULL,
  seq      TEXT,
  code     TEXT NOT NULL,
  name     TEXT,
  feature  TEXT,
  unit     TEXT,
  qty      REAL,
  price    REAL,
  total    REAL,
  category TEXT,
  extracted_at TEXT NOT NULL,
  PRIMARY KEY (project, file, sheet, code, seq)
);
CREATE INDEX IF NOT EXISTS idx_bp_proj ON bid_boq_price(project);
CREATE INDEX IF NOT EXISTS idx_bp_code ON bid_boq_price(code);
""")
# 加 item 表的索引（无价数据会分流到那里）
additional_idx = "CREATE INDEX IF NOT EXISTS idx_bi_proj ON bid_boq_item(project)"
try:
    db.execute(additional_idx)
except Exception:
    pass
db.execute("DELETE FROM bid_boq_price")
# 只清掉本次要写入的“无价分流”标记，不删历史 Excel 数据（可能来源不同）
# 实际做法：以 file 前缀判断本脚本产出的范围，简化处理：先记下原有 file 集合


now = time.strftime("%Y-%m-%dT%H:%M:%S")
total_items = 0
check_ok = 0
check_bad = 0
no_price_cnt = 0
summary = []

for pdir in sorted(os.listdir(DEST)):
    p = os.path.join(DEST, pdir)
    if not os.path.isdir(p):
        continue
    excels = glob.glob(os.path.join(p, "**", "*.xls"), recursive=True) + glob.glob(os.path.join(p, "**", "*.xlsx"), recursive=True)
    proj_items = 0
    for fp in excels:
        rel = os.path.relpath(fp, p)
        for sname, rows in read(fp):
            # 不看 sheet 名，只看没看表头——实测蜀山区的 sheet 叫「安装工程」/「建筑工程」，
            # 画根据地名字过滤会漏掉整份清单。
            hdr, col = find_header(rows)
            if hdr < 0:
                continue
            cur_cat = ""
            for r in rows[hdr + 1:]:
                def g(k):
                    j = col.get(k)
                    return r[j] if j is not None and j < len(r) else None
                code = cs(g("code"))
                name = cs(g("name"))
                unit = cs(g("unit"))
                qty = fnum(g("qty"))
                if not code and not name:
                    continue
                # 分组标题：无单位、无量
                if not unit and qty is None:
                    if name and len(name) < 30 and "小计" not in name and "合计" not in name:
                        cur_cat = name
                    continue
                if not CODE12.match(code):
                    continue
                price = fnum(g("price"))
                tot = fnum(g("total"))
                # 分流：有价的进 bid_boq_price，无价的进 bid_boq_item
                # （实测蜀山区的「清单表」也是招标模板，单价/总价列为空）
                if price is None and tot is None:
                    db.execute(
                        "INSERT OR REPLACE INTO bid_boq_item VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (pdir, rel[:120], sname[:60], cs(g("seq")), code, name[:120],
                         cs(g("feature"))[:400], unit[:16], qty, cur_cat[:60], now),
                    )
                    no_price_cnt += 1
                    continue
                # 自洽校验：qty × price ≈ total
                if qty and price and tot:
                    if abs(qty * price - tot) / max(tot, 1) < 0.02:
                        check_ok += 1
                    else:
                        check_bad += 1
                db.execute("INSERT OR REPLACE INTO bid_boq_price VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                           (pdir, rel[:120], sname[:60], cs(g("seq")), code, name[:120],
                            cs(g("feature"))[:400], unit[:16], qty, price, tot, cur_cat[:60], now))
                proj_items += 1
    if proj_items:
        summary.append((pdir, proj_items))
        total_items += proj_items

db.commit()
print(f"{'='*72}")
print(f"有价清单 {total_items} 条，来自 {len(summary)} 个项目")
print(f"无价清单 {no_price_cnt} 条 → 分流到 bid_boq_item")
print(f"自洽校验（工程量×单价≈合价）：通过 {check_ok}，不符 {check_bad}  （通过率 {check_ok/max(check_ok+check_bad,1)*100:.1f}%）")
print(f"{'='*72}\n")

for prj, n in summary:
    s = db.execute("""SELECT COUNT(*) n, SUM(qty) q, ROUND(SUM(total),0) t,
      ROUND(SUM(total)/10000,1) wan, SUM(CASE WHEN price IS NOT NULL THEN 1 ELSE 0 END) withp
      FROM bid_boq_price WHERE project=?""", (prj,)).fetchone()
    print(f"{prj[:44]:<46} {s[0]:>4} 项  合价 {s[3] or 0:>8} 万  有单价 {s[4]}")

print(f"\n单价 Top 12（元/单位）：")
for r in db.execute("""SELECT name, unit, ROUND(price,2) p, COUNT(*) n FROM bid_boq_price
  WHERE price IS NOT NULL AND price>0 GROUP BY name, unit ORDER BY price DESC LIMIT 12"""):
    print(f"  {r[0][:30]:<32} {r[1]:<4} {r[2]:>12,.2f}  ×{r[3]}")
db.close()
