"""
数据浏览器后端：21 张表 + 3 个视图，支持分页、搜索、排序。

只读 + 表名白名单，不接受任意 SQL。

启动：python web/server.py [端口]
访问：http://127.0.0.1:8420/
"""
import sys, os, json, sqlite3, mimetypes
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.path.dirname(ROOT), "data")
DB = os.path.join(DATA_DIR, "index.db")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8420

# 表分组（顺序即侧栏顺序）
GROUPS = [
    ("公开数据", ["announcement", "attachment", "announcement_attachment"]),
    ("招标解析", ["tender_doc", "scoring_item", "clarification_qa"]),
    ("价格数据", ["bid_result", "bid_body_result", "tender_control_price", "tender_price_raw"]),
    ("招投标画像", ["tender_buyer", "tender_duration"]),
    ("私有清单", ["bid_boq_item", "bid_boq_price", "bid_boq_xml", "bid_boq_measure", "bid_control_price"]),
    ("统一视图", ["v_boq_all", "v_boq_merged", "v_boq_stat"]),
    ("标准库", ["standard_ref", "db34_standard", "standard_project", "standard_research"]),
    ("履约", ["performance_record"]),
    ("系统", ["crawl_state", "crawl_failure"]),
]
LABELS = {
    "announcement": "公告", "attachment": "附件", "announcement_attachment": "公告↔附件",
    "tender_doc": "招标文件解析", "scoring_item": "评分表", "clarification_qa": "澄清问答",
    "bid_result": "中标结果（附件）", "bid_body_result": "中标结果（正文）",
    "tender_control_price": "控制价", "tender_price_raw": "控制价原文",
    "tender_buyer": "招标人/代理", "tender_duration": "工期", "bid_boq_item": "清单（无价）",
    "bid_boq_price": "清单（带价）", "bid_boq_xml": "清单（XML）",
    "bid_boq_measure": "措施费率", "bid_control_price": "项目控制价",
    "v_boq_all": "全部清单行", "v_boq_merged": "清单（去重）", "v_boq_stat": "清单（聚合）",
    "standard_ref": "标准库", "db34_standard": "DB34 地标",
    "standard_project": "标准↔项目类型", "standard_research": "调研记录",
    "performance_record": "履约信息", "crawl_state": "抓取进度", "crawl_failure": "抓取失败",
}

def conn():
    c = sqlite3.connect(DB, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA query_only = ON")
    return c

# 字段中文名（144 个，来自 data/col-labels.json）
_COL_FILE = os.path.join(os.path.dirname(ROOT), "data", "col-labels.json")
try:
    COL_LABELS = json.load(open(_COL_FILE, encoding="utf-8"))
except Exception:
    COL_LABELS = {}

# SQLite 类型 → 中文
TYPE_CN = {
    "TEXT": "文本", "VARCHAR": "文本", "CHAR": "文本", "CLOB": "文本",
    "INTEGER": "整数", "INT": "整数", "BIGINT": "整数", "SMALLINT": "整数",
    "REAL": "小数", "FLOAT": "小数", "DOUBLE": "小数", "NUMERIC": "小数",
    "BLOB": "二进制", "": "未知",
}

def type_cn(t):
    t = (t or "").upper().split("(")[0]
    return TYPE_CN.get(t, t or "未知")

# 枚举值中文映射：字段名 → {原值: 中文}
ENUMS = {
    "bulletin_nature": {"1": "招标公告", "2": "中标候选人", "3": "中标结果"},
    "primary_tag": {"building": "房建", "power": "电力", "pv": "光伏", "storage": "储能"},
    "detail_type": {"tender": "招标公告", "zbjg": "中标结果"},
    "confidence": {"high": "高", "medium": "中", "low": "低", "suspect": "存疑"},
    "src": {"excel": "表格", "xml": "清单XML", "price": "控制价"},
    "text_quality": {"high": "高", "medium": "中", "low": "低"},
    "severity": {"high": "高", "medium": "中", "low": "低"},
    "price_kind": {"限价": "最高限价", "估算": "合同估算价", "预算": "预算金额", "其他": "其他"},
    "subject_role": {"投标人": "投标人", "招标人": "招标人", "中标人": "中标人"},
    "stage": {"list": "列表", "detail": "详情", "attach": "附件"},
    "status": {"ok": "成功", "failed": "失败"},
}

TAG_CN = {
    "building": "房建", "power": "电力", "pv": "光伏", "storage": "储能",
    "quality": "质量", "safety": "安全", "cost": "造价", "schedule": "工期",
}
SRC_WORD = {"body": "正文", "title": "标题", "attach": "附件", "list": "列表", "detail": "详情"}

def fmt_tags(v):
    """["building","power"] → 房建、电力"""
    if not isinstance(v, str):
        return v
    try:
        arr = json.loads(v)
        if isinstance(arr, list):
            return "、".join(TAG_CN.get(str(x), str(x)) for x in arr) or "—"
    except Exception:
        pass
    return v

def fmt_evidence(v):
    """building:建筑面积@body+6 → 房建：建筑面积 @正文 +6"""
    if not isinstance(v, str):
        return v
    s = v
    for k, cn in TAG_CN.items():
        s = s.replace(k + ":", cn + "：").replace(k + "=", cn + "=")
    for k, cn in SRC_WORD.items():
        s = s.replace("@" + k, "@" + cn)
    return s

SPECIAL = {"tags": fmt_tags, "evidence": fmt_evidence, "sources": None}

def enum_cn(col, v):
    m = ENUMS.get(col)
    if not m or v is None:
        return v
    return m.get(str(v), v)

def schema():
    db = conn()
    out = []
    for grp, names in GROUPS:
        g = {"group": grp, "tables": []}
        for name in names:
            try:
                n = db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
            except sqlite3.Error:
                continue
            cols = []
            for c in db.execute(f'PRAGMA table_info("{name}")'):
                cols.append({
                    "name": c[1],
                    "label": COL_LABELS.get(c[1], c[1]),
                    "type": (c[2] or "").upper(),
                    "type_cn": type_cn(c[2]),
                    "pk": bool(c[5]),
                })
            g["tables"].append({
                "name": name, "label": LABELS.get(name, name),
                "rows": n, "cols": cols,
                "kind": "view" if name.startswith("v_") else "table",
            })
        if g["tables"]:
            out.append(g)
    db.close()
    return out

ALLOWED = {t["name"]: t for g in schema() for t in g["tables"]}

def query(table, page, size, q, sort, direction):
    if table not in ALLOWED:
        return {"error": "unknown table"}
    meta = ALLOWED[table]
    colnames = [c["name"] for c in meta["cols"]]
    textcols = [c["name"] for c in meta["cols"] if "TEXT" in c["type"] or not c["type"]]
    db = conn()

    where, params = "", []
    if q:
        if textcols:
            # 搜索所有文本列；CAST 让数字列也能被搜到
            parts = [f'"{c}" LIKE ?' for c in textcols]
            where = " WHERE (" + " OR ".join(parts) + ")"
            params = [f"%{q}%"] * len(textcols)

    sortcol = sort if sort in colnames else (colnames[0] if colnames else None)
    dir_sql = "DESC" if str(direction).lower() == "desc" else "ASC"
    order = f' ORDER BY "{sortcol}" {dir_sql}' if sortcol else ""

    total = db.execute(f'SELECT COUNT(*) FROM "{table}"{where}', params).fetchone()[0]
    rows = db.execute(
        f'SELECT * FROM "{table}"{where}{order} LIMIT ? OFFSET ?',
        params + [size, (page - 1) * size],
    ).fetchall()
    db.close()

    # 转成数组（保序、省字节）；超长文本截断并标记
    out = []
    enums = {c: ENUMS.get(c) for c in colnames if c in ENUMS}
    for r in rows:
        line = []
        for c in colnames:
            v = r[c]
            if c in enums:
                line.append(enum_cn(c, v))
            elif c in ("tags", "evidence"):
                line.append(fmt_tags(v) if c == "tags" else fmt_evidence(v))
            elif isinstance(v, str) and len(v) > 300:
                line.append({"t": v[:300], "trunc": len(v)})
            elif isinstance(v, bytes):
                line.append({"b": len(v)})
            else:
                line.append(v)
        out.append(line)
    return {
        "table": table, "total": total, "page": page, "size": size,
        "pages": max(1, (total + size - 1) // size),
        "cols": meta["cols"], "rows": out,
        "sort": sortcol, "dir": dir_sql.lower(),
    }

# 关联关系：主表 → [(显示名, 从表, 外键, 展示列)]
RELATIONS = {
    "announcement": [
        {"rel": "相关附件", "table": "attachment", "fk": "announcement_guid",
         "cols": ["filename", "ext", "size_bytes", "local_path", "status"],
         "order": "size_bytes DESC"},
        {"rel": "招标文件解析", "table": "tender_doc", "fk": "announcement_guid",
         "cols": ["pages", "evaluation_method", "score_technical", "score_commercial", "score_price", "score_verified"]},
        {"rel": "澄清问答", "table": "clarification_qa", "fk": "announcement_guid",
         "cols": ["seq", "question", "answer", "affects"]},
        {"rel": "中标结果（正文）", "table": "bid_body_result", "fk": "announcement_guid",
         "cols": ["winner", "winner_price", "confidence", "evidence"]},
        {"rel": "控制价", "table": "tender_control_price", "fk": "announcement_guid",
         "cols": ["amount", "price_kind", "label", "amount_raw"]},
    ],
    "attachment": [
        {"rel": "招标文件解析", "table": "tender_doc", "fk": "attach_guid",
         "cols": ["pages", "evaluation_method", "score_technical", "score_commercial", "score_price"]},
        {"rel": "中标结果", "table": "bid_result", "fk": "attach_guid",
         "cols": ["winner", "winner_price", "confidence"]},
        {"rel": "评分表", "table": "scoring_item", "fk": "attach_guid",
         "cols": ["page", "seq", "cells_json"], "order": "page ASC"},
        {"rel": "澄清问答", "table": "clarification_qa", "fk": "attach_guid",
         "cols": ["seq", "question", "answer"]},
    ],
    "tender_doc": [
        {"rel": "评分表", "table": "scoring_item", "fk": "attach_guid",
         "cols": ["page", "seq", "cells_json"], "order": "page ASC"},
        {"rel": "澄清问答", "table": "clarification_qa", "fk": "attach_guid",
         "cols": ["seq", "question", "answer", "affects"]},
    ],
    "bid_body_result": [
        {"rel": "控制价（同公告）", "table": "tender_control_price", "fk": "announcement_guid",
         "cols": ["amount", "price_kind", "label"]},
    ],
    "bid_boq_item": [
        {"rel": "带价清单（同项目）", "table": "bid_boq_price", "fk": "project",
         "cols": ["code", "name", "unit", "qty", "price", "total"]},
    ],
}

REL_LIMIT = 30

def related(table, key):
    """返回某行的所有关联数据"""
    rels = RELATIONS.get(table)
    if not rels or not key:
        return {"groups": []}
    db = conn()
    out = []
    for r in rels:
        try:
            cols_sql = ", ".join(f'"{c}"' for c in r["cols"])
            sql = f'SELECT {cols_sql} FROM "{r["table"]}" WHERE "{r["fk"]}" = ?'
            if r.get("order"):
                sql += " ORDER BY " + r["order"]
            sql += " LIMIT ?"
            rows = db.execute(sql, (key, REL_LIMIT)).fetchall()
            total = db.execute(
                f'SELECT COUNT(*) FROM "{r["table"]}" WHERE "{r["fk"]}" = ?', (key,)
            ).fetchone()[0]
        except sqlite3.Error:
            continue
        if total == 0:
            continue
        clipped = []
        for row in rows:
            line = []
            for c in r["cols"]:
                v = row[c]
                if isinstance(v, str) and len(v) > 160:
                    line.append({"t": v[:160], "trunc": len(v)})
                else:
                    line.append(enum_cn(c, v) if c in ENUMS else v)
            clipped.append(line)
        out.append({
            "rel": r["rel"], "table": r["table"], "total": total,
            "cols": [{"name": c, "label": COL_LABELS.get(c, c)} for c in r["cols"]],
            "rows": clipped,
        })
    db.close()
    return {"groups": out}

def overview():
    db = conn()
    def n(sql):
        try:
            return db.execute(sql).fetchone()[0]
        except sqlite3.Error:
            return None
    stats = {
        "公告": n("SELECT COUNT(*) FROM announcement"),
        "附件": n("SELECT COUNT(*) FROM attachment WHERE status='ok'"),
        "招标文件": n("SELECT COUNT(*) FROM tender_doc"),
        "评分行": n("SELECT COUNT(*) FROM scoring_item"),
        "澄清问答": n("SELECT COUNT(*) FROM clarification_qa"),
        "中标价": n("SELECT COUNT(*) FROM bid_result WHERE winner_price IS NOT NULL"),
        "正文中标价": n("SELECT COUNT(*) FROM bid_body_result WHERE winner_price IS NOT NULL"),
        "控制价": n("SELECT COUNT(*) FROM tender_control_price"),
        "清单行": n("SELECT COUNT(*) FROM v_boq_all"),
        "带价清单": n("SELECT COUNT(*) FROM bid_boq_price"),
        "标准": n("SELECT COUNT(*) FROM standard_ref"),
        "地标": n("SELECT COUNT(*) FROM db34_standard"),
        "履约": n("SELECT COUNT(*) FROM performance_record"),
    }
    db.close()
    return stats

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200, ctype="application/json; charset=utf-8"):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        qs = parse_qs(u.query)

        def one(k, d=None):
            v = qs.get(k)
            return v[0] if v else d

        try:
            if p == "/api/schema":
                return self._send({"groups": schema(), "stats": overview()})
            if p == "/api/rows":
                t = one("t", "")
                page = max(1, int(one("p", "1")))
                size = min(500, max(10, int(one("s", "50"))))
                return self._send(query(t, page, size, one("q", ""), one("sort"), one("dir", "asc")))
            if p == "/api/related":
                return self._send(related(one("t", ""), one("k", "")))
            if p in ("/", "/index.html"):
                fp = os.path.join(ROOT, "index.html")
                with open(fp, "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            # 源文件预览/下载：/api/file?p=attachments/xxx/yyy.pdf
            if p == "/api/file":
                rel = one("p", "").replace("\\", "/")
                if not rel:
                    return self._send({"error": "missing p"}, 400)
                full = os.path.normpath(os.path.join(DATA_DIR, rel))
                # 防目录穿越：必须落在 data/ 内
                if not full.startswith(DATA_DIR + os.sep):
                    return self._send({"error": "forbidden"}, 403)
                if not os.path.isfile(full):
                    return self._send({"error": "not found", "path": rel}, 404)
                ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
                size = os.path.getsize(full)
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(size))
                # inline：PDF/图片浏览器直接预览；其他类型浏览器自行决定
                self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{quote(os.path.basename(full))}")
                self.end_headers()
                with open(full, "rb") as f:
                    while True:
                        chunk = f.read(256 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                return
            # 文件存在性检查（前端先探测再给按钮）
            if p == "/api/fileinfo":
                rel = one("p", "").replace("\\", "/")
                full = os.path.normpath(os.path.join(DATA_DIR, rel))
                ok = full.startswith(DATA_DIR + os.sep) and os.path.isfile(full)
                ctype = mimetypes.guess_type(full)[0] if ok else None
                return self._send({
                    "exists": ok, "type": ctype,
                    "size": os.path.getsize(full) if ok else 0,
                    "name": os.path.basename(full) if ok else "",
                })
            # 静态资源
            fp = os.path.join(ROOT, p.lstrip("/"))
            if os.path.isfile(fp):
                ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
                with open(fp, "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self._send({"error": "not found"}, 404)
        except Exception as e:
            self._send({"error": f"{type(e).__name__}: {e}"}, 500)

if __name__ == "__main__":
    print(f"数据浏览器 → http://127.0.0.1:{PORT}/")
    print(f"数据库：{DB}")
    total = sum(t["rows"] for g in schema() for t in g["tables"])
    print(f"{len(ALLOWED)} 张表/视图，合计 {total:,} 行")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
