"""解析 .18zhzb / .18zhxj（广联达经济标 XML）→ bid_boq_xml 表。

为什么值得单独入库：XML 版比 Excel 版多两个字段——
  · Jsgz（计算规则）：如「按建筑物首层建筑面积，以面积计算」
  · 措施项目费率（ZjCsMx 的 Fl）：如「夜间施工增加费 0.5%」

实测可解析的只有 4 个文件（其余 32 个专有格式的正文是加密的，需 CA 锁）：
  · .hfzf/.18whzf/.aqzf/.szzf/.maszf/.bbzf/.czzf/.hnzf → <ZBFile> 但 <ZBFileContent> 加密
  · .hfszb → 加密 ZIP（password required）

用法：python src/bid-boq-xml.py
"""
import sys, os, json, zipfile, re, sqlite3, time
import xml.etree.ElementTree as ET
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.environ.get("BID_INFO_ROOT", r"D:\bid-info")
_DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
OUT = os.path.join(_DATA, "bid-info")
DB = os.path.join(_DATA, "index.db")
PLAIN = {".18zhzb", ".18zhxj", ".18aqzb", ".18czb", ".18whcf"}

def fix_name(n):
    try:
        return n.encode("cp437").decode("gbk")
    except Exception:
        return n

inv = json.load(open(os.path.join(OUT, "inventory2.json"), encoding="utf-8"))
targets = []
for p in inv:
    for f in p["files"]:
        if f["ext"] in PLAIN:
            targets.append((p["project"], p["zip"], f))
print(f"待解析明文计价文件：{len(targets)} 个\n")

def getb(zip_name, name, size):
    with zipfile.ZipFile(os.path.join(ROOT, zip_name)) as zf:
        for i in zf.infolist():
            if i.filename.endswith("/"):
                continue
            if i.file_size == size and fix_name(i.filename) == name:
                return zf.read(i)
    return None

db = sqlite3.connect(DB)
db.execute("PRAGMA busy_timeout=30000")
db.executescript("""
CREATE TABLE IF NOT EXISTS bid_boq_xml (
  project    TEXT NOT NULL,
  file       TEXT NOT NULL,
  dwgc       TEXT,          -- 单位工程名
  seq        TEXT,
  code       TEXT NOT NULL, -- 清单编码 Qdbm
  name       TEXT,          -- 名称 Mc
  feature    TEXT,          -- 项目特征 Xmtz
  calc_rule  TEXT,          -- 计算规则 Jsgz（Excel 版没有）
  unit       TEXT,          -- 单位 Dw
  qty        REAL,          -- 数量 Sl
  category   TEXT,          -- 所属分部（最近一个 QdBt）
  extracted_at TEXT NOT NULL,
  PRIMARY KEY (project, file, code, seq)
);
CREATE TABLE IF NOT EXISTS bid_boq_measure (
  project TEXT NOT NULL,
  file    TEXT NOT NULL,
  seq     TEXT,
  code    TEXT,          -- 项目编码 Xmbm，如 JC-01
  name    TEXT,          -- 名称
  base    TEXT,          -- 计算基数说明 Jsgs
  rate    REAL,          -- 费率 Fl（%）
  category TEXT,         -- 措施类别 Cslb
  PRIMARY KEY (project, file, code, seq)
);
""")
db.execute("DELETE FROM bid_boq_xml")
db.execute("DELETE FROM bid_boq_measure")

now = time.strftime("%Y-%m-%dT%H:%M:%S")
ok = 0
fail = 0
tot_items = 0
tot_meas = 0
for project, zip_name, f in targets:
    data = getb(zip_name, f["name"], f["size"])
    if not data:
        print(f"  ✗ 取不出 {f['name'][:50]}")
        fail += 1
        continue
    try:
        root = ET.fromstring(data.decode("utf-8-sig"))
    except Exception as e:
        print(f"  ✗ XML 解析失败 {f['name'][:40]}  {type(e).__name__}")
        fail += 1
        continue
    if root.tag != "JingJiBiao":
        print(f"  - 跳过 {f['name'][:40]}（根标签 {root.tag}，不是清单）")
        fail += 1
        continue

    n_item = 0
    n_meas = 0
    for dwgc in root.iter("Dwgcxx"):
        dwname = dwgc.get("Dwgcmc", "")
        # 遍历该单位工程下的分部标题与清单，保持顺序以归属分部
        cur_cat = ""
        for node in dwgc.iter():
            if node.tag == "QdBt":
                cur_cat = node.get("Mc", "")[:60]
            elif node.tag == "Qdmx":
                code = node.get("Qdbm", "")
                if not code:
                    continue
                try:
                    qty = float(node.get("Sl") or 0)
                except ValueError:
                    qty = None
                db.execute(
                    "INSERT OR REPLACE INTO bid_boq_xml VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (project, f["name"][:120], dwname[:80], node.get("Xh"), code,
                     (node.get("Mc") or "")[:120], (node.get("Xmtz") or "")[:400],
                     (node.get("Jsgz") or "")[:200], (node.get("Dw") or "")[:16],
                     qty, cur_cat, now),
                )
                n_item += 1
        # 措施项目
        for mx in dwgc.iter("ZjCsMx"):
            try:
                rate = float(mx.get("Fl") or 0)
            except ValueError:
                rate = None
            db.execute(
                "INSERT OR REPLACE INTO bid_boq_measure VALUES (?,?,?,?,?,?,?,?)",
                (project, f["name"][:120], mx.get("Xh"), mx.get("Xmbm"),
                 (mx.get("Mc") or "")[:80], (mx.get("Jsgs") or "")[:200], rate,
                 mx.get("Cslb")),
            )
            n_meas += 1

    ok += 1
    tot_items += n_item
    tot_meas += n_meas
    print(f"  ✓ {project[:30]:<32} 清单 {n_item:>4} 条  措施 {n_meas:>3} 项")

db.commit()
print(f"\n成功 {ok} 个文件，失败/跳过 {fail} 个")
print(f"bid_boq_xml     {tot_items} 条（含计算规则）")
print(f"bid_boq_measure {tot_meas} 项（含费率）")

print(f"\n=== 计算规则样本 ===")
for r in db.execute("SELECT name, calc_rule FROM bid_boq_xml WHERE calc_rule<>'' LIMIT 5"):
    print(f"  {r[0][:20]:<22} {r[1][:60]}")
print(f"\n=== 措施费率样本 ===")
for r in db.execute("SELECT name, rate FROM bid_boq_measure WHERE rate>0 LIMIT 6"):
    print(f"  {r[0][:24]:<26} {r[1]}%")

n = db.execute("SELECT COUNT(*) FROM bid_boq_xml WHERE calc_rule<>''").fetchone()[0]
print(f"\n有计算规则的清单：{n} / {tot_items}")
db.close()
