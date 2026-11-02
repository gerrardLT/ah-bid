"""第 2 步：解析 241 个 Excel 清单，提取分部分项工程量。

结构（安徽 2018 计价依据）：
  E.1 分部分项工程量清单与计价表    ← 核心
  表头：序号 | 项目编码 | 项目名称 | 项目特征描述 | 计量单位 | 工程量 | 综合单价 | 合价
  数据行：12 位编码 = 清单项；非 12 位（如 001）= 分组标题

产出表 bid_boq_item：
  project, file, sheet, seq, code, name, feature, unit, qty, category

用法：python src/bid-boq.py
"""
import sys, os, io, json, re, sqlite3, zipfile, tempfile, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import xlrd, openpyxl

# 私有数据源允许用环境变量覆盖；项目内的输出路径按脚本位置推导
ROOT = os.environ.get("BID_INFO_ROOT", r"D:\bid-info")
DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
OUT = os.path.join(DATA, "bid-info")
DB = os.path.join(DATA, "index.db")

def fix_name(n):
    try:
        return n.encode("cp437").decode("gbk")
    except Exception:
        return n

def read_bytes(zip_path, want_name):
    def walk(zf, depth=0):
        for info in zf.infolist():
            nm = fix_name(info.filename)
            if info.filename.endswith("/"):
                continue
            if nm == want_name:
                return zf.read(info)
            if nm.lower().endswith(".zip") and depth < 3:
                try:
                    with zipfile.ZipFile(io.BytesIO(zf.read(info))) as inner:
                        r = walk(inner, depth + 1)
                        if r:
                            return r
                except Exception:
                    pass
        return None
    with zipfile.ZipFile(zip_path) as zf:
        return walk(zf)

def load_sheets(data, magic):
    tmp = os.path.join(tempfile.gettempdir(), "boq_w")
    if magic == "ole2":
        p = tmp + ".xls"
        open(p, "wb").write(data)
        wb = xlrd.open_workbook(p)
        return [(s.name, [[s.cell_value(r, c) for c in range(s.ncols)] for r in range(s.nrows)]) for s in wb.sheets()]
    p = tmp + ".xlsx"
    open(p, "wb").write(data)
    wb = openpyxl.load_workbook(p, data_only=True, read_only=True)
    out = []
    for ws in wb.worksheets:
        out.append((ws.title, [list(row) for row in ws.iter_rows(values_only=True)]))
    wb.close()
    return out

# 分部分项 sheet 的识别（E.1 是最标准的，也有叫"分部分项工程量清单计价表"的）
DIV_SHEET = re.compile(r"(E\.?1|分部分项)", re.I)
CODE12 = re.compile(r"^\d{12}$")
UNIT_SET = {"m³", "m3", "m²", "m2", "m", "t", "kg", "个", "台", "套", "组", "根", "米", "平方米", "立方米", "吨", "项", "处", "座", "只", "块", "樘", "段", "km", "千米"}

def cell_s(v):
    if v is None:
        return ""
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    # Excel 里单元格内常有换行（如「计量\n单位」），先归一化再处理
    return re.sub(r"[\r\n\t]+", " ", str(v)).strip()

def find_header(rows, limit=40):
    """找表头行，返回 (行号, 列映射)"""
    for i, r in enumerate(rows[:limit]):
        txt = " ".join(cell_s(c) for c in r)
        if ("项目编码" in txt or "项目编号" in txt) and ("工程量" in txt or "计量单位" in txt):
            col = {}
            for j, c in enumerate(r):
                # 必须去全部空白（含换行），否则「计量\n单位」认不出来
                s = re.sub(r"\s+", "", cell_s(c))
                if not s:
                    continue
                if "项目编码" in s or "项目编号" in s:
                    col.setdefault("code", j)
                elif "项目名称" in s:
                    col.setdefault("name", j)
                elif "项目特征" in s:
                    col.setdefault("feature", j)
                elif "计量单位" in s or s == "单位":
                    col.setdefault("unit", j)
                elif "工程量" in s and "单价" not in s:
                    col.setdefault("qty", j)
                elif s in ("序号",):
                    col.setdefault("seq", j)
            if "code" in col and "qty" in col:
                return i, col
    return -1, {}

def parse_sheet(rows):
    """返回 (items, stats)"""
    hdr, col = find_header(rows)
    if hdr < 0:
        return [], {"reason": "no_header"}
    items = []
    cur_cat = ""
    for r in rows[hdr + 1:]:
        def get(k):
            j = col.get(k)
            return r[j] if j is not None and j < len(r) else None
        code = cell_s(get("code"))
        name = cell_s(get("name"))
        unit = cell_s(get("unit"))
        qty_raw = cell_s(get("qty")).replace(",", "")
        if not code and not name:
            continue
        # 分组标题的判据：**没有单位也没有工程量**（不是看编码位数）。
        # 之前用「非 12 位编码就当分组」会误判——有些清单编码用 9 位或带字母。
        if not unit and not qty_raw:
            if name and len(name) < 30 and not name.startswith("本页") and "小计" not in name and "合计" not in name:
                cur_cat = name
            continue
        if not CODE12.match(code):
            continue
        try:
            qty = float(qty_raw) if qty_raw else None
        except ValueError:
            qty = None
        items.append({
            "seq": cell_s(get("seq")),
            "code": code,
            "name": name[:120],
            "feature": cell_s(get("feature"))[:400],
            "unit": unit[:16],
            "qty": qty,
            "category": cur_cat[:60],
        })
    return items, {"header_row": hdr, "cols": col}

# ---------- 主流程 ----------
inv = json.load(open(os.path.join(OUT, "inventory2.json"), encoding="utf-8"))
targets = []
for p in inv:
    for f in p["files"]:
        if f["ext"] in (".xls", ".xlsx") and f.get("magic") in ("ole2", "zip"):
            targets.append((p["project"], p["zip"], f))

print(f"待解析 Excel：{len(targets)} 个\n")

db = sqlite3.connect(DB)
db.execute("PRAGMA busy_timeout=30000")
db.executescript("""
CREATE TABLE IF NOT EXISTS bid_boq_item (
  project   TEXT NOT NULL,
  file      TEXT NOT NULL,
  sheet     TEXT NOT NULL,
  seq       TEXT,
  code      TEXT NOT NULL,
  name      TEXT,
  feature   TEXT,
  unit      TEXT,
  qty       REAL,
  category  TEXT,
  extracted_at TEXT NOT NULL,
  PRIMARY KEY (project, file, sheet, code, seq)
);
CREATE INDEX IF NOT EXISTS idx_boq_proj ON bid_boq_item(project);
CREATE INDEX IF NOT EXISTS idx_boq_code ON bid_boq_item(code);
""")
db.execute("DELETE FROM bid_boq_item")  # 全量重建，避免残留

now = time.strftime("%Y-%m-%dT%H:%M:%S")
ok = fail = 0
total_items = 0
parsed_files = 0
sheet_stats = []
errs = []

for project, zip_name, f in targets:
    try:
        data = read_bytes(os.path.join(ROOT, zip_name), f["name"])
        if not data:
            fail += 1
            errs.append((project, f["name"], "读不到"))
            continue
        sheets = load_sheets(data, f["magic"])
    except Exception as e:
        fail += 1
        errs.append((project, f["name"], f"{type(e).__name__}: {e}"[:60]))
        continue

    got = 0
    for sname, rows in sheets:
        if not DIV_SHEET.search(sname):
            continue
        items, st = parse_sheet(rows)
        if not items:
            continue
        for it in items:
            db.execute(
                "INSERT OR REPLACE INTO bid_boq_item VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (project, f["name"][:120], sname[:60], it["seq"], it["code"], it["name"],
                 it["feature"], it["unit"], it["qty"], it["category"], now),
            )
        got += len(items)
        sheet_stats.append((project, sname[:40], len(items)))
    if got:
        parsed_files += 1
        total_items += got
        ok += 1
    else:
        fail += 1
        errs.append((project, f["name"], "无分部分项数据"))

db.commit()

print(f"{'='*70}")
print(f"解析完成：成功 {ok} 个文件 / 失败 {fail} 个")
print(f"提取清单项 {total_items} 条，来自 {parsed_files} 个文件")
print(f"{'='*70}")

if errs:
    print(f"\n未提取到数据的文件（前 10）：")
    for p, f, r in errs[:10]:
        print(f"  {p[:22]:<24} {f[:40]:<42} {r}")

print(f"\n按项目的清单项数：")
for r in db.execute("SELECT project, COUNT(*) n, COUNT(DISTINCT code) c, ROUND(SUM(qty),1) q FROM bid_boq_item GROUP BY project ORDER BY n DESC"):
    print(f"  {r[0][:34]:<36} {r[1]:>5} 项  {r[2]:>4} 种编码  量合计 {r[3] if r[3] is not None else '-'}")

print(f"\n分部（category）Top 12：")
for r in db.execute("SELECT category, COUNT(*) n FROM bid_boq_item WHERE category<>'' GROUP BY category ORDER BY n DESC LIMIT 12"):
    print(f"  {r[0][:40]:<42} {r[1]:>5}")

print(f"\n清单编码前 6 位（=专业+章节）Top 15：")
for r in db.execute("SELECT substr(code,1,6) c6, COUNT(*) n, COUNT(DISTINCT project) p FROM bid_boq_item GROUP BY c6 ORDER BY n DESC LIMIT 15"):
    print(f"  {r[0]}  {r[1]:>5} 项  分布在 {r[2]} 个项目")
db.close()
