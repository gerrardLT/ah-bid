"""
数据浏览器后端：21 张表 + 3 个视图，支持分页、搜索、排序。

只读 + 表名白名单，不接受任意 SQL。

启动：python web/server.py [端口]
访问：http://127.0.0.1:8420/
"""
import sys, os, json, sqlite3, mimetypes, re, subprocess, tempfile, threading, time
from datetime import datetime
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

# ---------------- 技术标自检 ----------------
#
# 前端只做两件事：把 docx 传上来、把返回的 JSON 画出来。
# 所有计算都在 src/tech-bid-check.ts 里，这里只负责落临时文件、调进程、存历史。
# 这样 CLI / Markdown / 面板三条出口用的是同一份诊断结果。

PROJ = os.path.dirname(ROOT)
CHECKS_DIR = os.path.join(PROJ, "output", "checks")
ALLOWED_EXT = {".docx", ".doc", ".md", ".txt"}


def run_check(data: bytes, name: str, guid: str, ptype: str, title: str = "") -> dict:
    ext = os.path.splitext(name)[1].lower() or ".docx"
    if ext not in ALLOWED_EXT:
        return {"ok": False, "error": f"不支持的文件类型 {ext}（只收 docx / doc / md / txt）"}
    fd, tmp = tempfile.mkstemp(suffix=ext)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        cmd = ["node", "--no-warnings", "src/tech-bid-check.ts", f"--bid={tmp}", "--json"]
        if guid:
            cmd.append(f"--guid={guid}")
        elif title:
            # 用户没选具体项目、只输了关键词时走标题匹配
            cmd.append(f"--title={title}")
        if ptype:
            cmd.append(f"--project-type={ptype}")
        r = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=PROJ, timeout=180,
        )
        if r.returncode != 0:
            return {"ok": False, "error": (r.stderr or r.stdout or "自检失败")[-1200:]}
        try:
            parsed = json.loads(r.stdout)
        except json.JSONDecodeError:
            return {"ok": False, "error": "自检输出不是合法 JSON，请用 CLI 排查"}
        # 注意：这里不能把 json 结果赋值给 data —— data 是入参（文件字节），
        # 覆盖后下面的 data.decode() 会抛 AttributeError 并被 except 吞掉，
        # 表现为「明明上传成功但没有原文」。用 parsed 单独存。
        # 另存一份纯文本：前端点证据行号时要能跳回原文定位。
        # 复用 docx-text.py，保证和诊断用的是同一套解析（表格按 `a | b | c` 保留列边界）。
        text = ""
        try:
            if ext in (".docx", ".doc"):
                tr = subprocess.run(
                    ["python", "src/docx-text.py", tmp],
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                    cwd=PROJ, timeout=120,
                )
                text = tr.stdout if tr.returncode == 0 else ""
            else:
                text = data.decode("utf-8", "replace")
        except Exception:
            text = ""
        return {"ok": True, "data": parsed, "text": text}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "自检超过 180 秒（清单解析可能卡住），请改用 CLI 加 --no-context"}
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def save_check(name: str, guid: str, ptype: str, data: dict, text: str = "") -> str:
    os.makedirs(CHECKS_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    stem = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", os.path.splitext(name)[0])[:40] or "check"
    path = os.path.join(CHECKS_DIR, f"{ts}-{stem}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(
            {"time": ts, "name": name, "guid": guid, "projectType": ptype, "data": data},
            f, ensure_ascii=False,
        )
    # 原文另存 .txt（与 json 同名），点行号时按需拉取。
    # 不塞进 JSON：一份标书几万字，30 条历史会撑到几十 MB。
    if text:
        with open(path[:-5] + ".txt", "w", encoding="utf-8") as f:
            f.write(text)
    return path


def list_checks() -> dict:
    if not os.path.isdir(CHECKS_DIR):
        return {"ok": True, "items": []}
    items = []
    for fn in sorted(os.listdir(CHECKS_DIR), reverse=True):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(CHECKS_DIR, fn), encoding="utf-8") as f:
                obj = json.load(f)
        except Exception:
            continue
        s = (obj.get("data") or {}).get("summary") or {}
        items.append({
            "file": fn,
            "time": obj.get("time"),
            "name": obj.get("name"),
            "covered": s.get("covered"),
            "mentioned": s.get("mentioned"),
            "missing": s.get("missing"),
            "rejectRisk": s.get("rejectRisk"),
        })
        if len(items) >= 30:
            break
    return {"ok": True, "items": items}


def get_check(fn: str) -> dict:
    if not fn or "/" in fn or "\\" in fn or not fn.endswith(".json"):
        return {"ok": False, "error": "非法文件名"}
    fp = os.path.join(CHECKS_DIR, fn)
    if not os.path.exists(fp):
        return {"ok": False, "error": "不存在"}
    with open(fp, encoding="utf-8") as f:
        return {"ok": True, "data": json.load(f)}


def _ro():
    return sqlite3.connect("file:" + DB + "?mode=ro", uri=True)


def _rows(cur, sql, args=()):
    cur.execute(sql, args)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def project_detail(guid: str) -> dict:
    """项目全景：一次把 7 张表聚合到一个响应里。

    为什么需要：原来要看一个项目，得在数据浏览器里分别翻 announcement / attachment /
    tender_doc / scoring_item / clarification_qa / bid_result / tender_control_price，
    靠 guid 手动对照。这个接口把它们拼在一起。
    """
    if not guid or len(guid) < 8:
        return {"ok": False, "error": "缺少 guid"}
    c = _ro()
    cur = c.cursor()
    hit = _rows(cur, "SELECT * FROM announcement WHERE guid = ?", (guid,))
    if not hit:
        c.close()
        return {"ok": False, "error": "项目不存在"}
    a = hit[0]
    body = a.pop("body_text", "") or ""
    a["body_chars"] = len(body)
    a["body_head"] = body[:800]
    a["body_full"] = body if len(body) <= 30000 else None

    atts = _rows(
        cur,
        "SELECT attach_guid, filename, ext, size_bytes, status, local_path FROM attachment "
        "WHERE announcement_guid = ? ORDER BY size_bytes DESC",
        (guid,),
    )
    docs = _rows(cur, "SELECT * FROM tender_doc WHERE announcement_guid = ? LIMIT 1", (guid,))
    doc = docs[0] if docs else None
    # 资格条件（从正文抽的，8,494 条里 5,008 条能抽出资质要求）
    clauses = _rows(
        cur,
        "SELECT qualification, builder, performance, joint_venture, qual_text, confidence, reason "
        "FROM announcement_clause WHERE announcement_guid = ? LIMIT 1",
        (guid,),
    )
    clause = clauses[0] if clauses else None
    # 业绩五要素（独立表：无门槛 / 见招标文件 / 有实质门槛 三态）
    # 用 try 保护：index.db 被 .gitignore 排除，announcement_perf 只由 extract-clauses 创建。
    # 别人拉下代码直接用现有库起服务时，缺表不该让整个项目页 500。
    try:
        perfRows = _rows(
            cur,
            "SELECT years, from_date, cnt, min_amount, scope, kind, proof, scale, evidence, "
            "notice, confidence, reason FROM announcement_perf WHERE announcement_guid = ? LIMIT 1",
            (guid,),
        )
    except sqlite3.Error:
        perfRows = []
    perf = perfRows[0] if perfRows else None
    clar = _rows(
        cur,
        "SELECT seq, question, answer, affects FROM clarification_qa "
        "WHERE announcement_guid = ? ORDER BY seq",
        (guid,),
    )
    res = _rows(cur, "SELECT * FROM bid_result WHERE announcement_guid = ? LIMIT 1", (guid,))
    prices = _rows(
        cur,
        "SELECT amount, price_kind FROM tender_control_price WHERE announcement_guid = ?",
        (guid,),
    )
    durs = _rows(cur, "SELECT days FROM tender_duration WHERE announcement_guid = ?", (guid,))

    scoring_rows = 0
    if doc:
        cur.execute("SELECT COUNT(*) FROM scoring_item_full WHERE attach_guid = ?", (doc["attach_guid"],))
        scoring_rows = cur.fetchone()[0]

    # 私有清单没有 announcement_guid，只能按项目名匹配（与 boq-signal.ts 同口径：取最长命中）
    boq = None
    projs = [r["project"] for r in _rows(cur, "SELECT DISTINCT project FROM bid_boq_item")]
    norm = lambda s: "".join((s or "").split())
    t = norm(a.get("title", ""))
    best, best_len = None, 0
    for p in projs:
        q = norm(p)
        if len(q) >= 6 and (t.find(q) >= 0 or (q.find(t) >= 0 and len(t) >= 10)) and len(q) > best_len:
            best, best_len = p, len(q)
    if best:
        cur.execute("SELECT COUNT(*) FROM bid_boq_item WHERE project = ?", (best,))
        boq = {"project": best, "rows": cur.fetchone()[0]}

    c.close()
    return {
        "ok": True,
        "data": {
            "announcement": a,
            "attachments": atts,
            "doc": doc,
            "clause": clause,
            "perf": perf,
            "clarifications": clar,
            "result": res[0] if res else None,
            "prices": prices,
            "durations": durs,
            "scoring_rows": scoring_rows,
            "boq": boq,
        },
    }


def search_projects(q: str, limit: int = 20) -> dict:
    """按标题或 guid 搜项目。给自检面板的下拉用。"""
    q = (q or "").strip()
    if not q:
        return {"ok": True, "items": []}
    c = _ro()
    cur = c.cursor()
    items = _rows(
        cur,
        "SELECT guid, title, city, pub_date, primary_tag, bulletin_nature FROM announcement "
        "WHERE title LIKE ? OR guid = ? ORDER BY pub_date DESC LIMIT ?",
        (f"%{q}%", q, min(50, max(1, limit))),
    )
    c.close()
    return {"ok": True, "items": items}


_DIGEST_CACHE: dict = {}
_DIGEST_LOCK = threading.Lock()
DIGEST_TTL = 120
DIGEST_MAX_DAYS = 90


def digest_json(days: int) -> dict:
    """调 daily-digest.ts 拿结构化日报 —— 不在这里重写 SQL，避免两套口径。

    三个保护：
    - days 钳到 1..90：原来 `?days=99999` 会扫全库
    - 120 秒缓存：一次请求 0.34s 里有 0.29s 是 node 冷启动，切 tab 就重付一次
    - 单飞锁：10 个并发请求会起 10 个 node 进程（每个约 40MB）
    """
    days = max(1, min(DIGEST_MAX_DAYS, int(days or 2)))

    hit = _DIGEST_CACHE.get(days)
    if hit and time.time() - hit[0] < DIGEST_TTL:
        return {**hit[1], "cached": True}

    with _DIGEST_LOCK:
        # 拿到锁后再看一次：等锁期间可能已被别人算好
        hit = _DIGEST_CACHE.get(days)
        if hit and time.time() - hit[0] < DIGEST_TTL:
            return {**hit[1], "cached": True}

        try:
            r = subprocess.run(
                ["node", "--no-warnings", "src/daily-digest.ts", f"--days={days}", "--json"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                cwd=PROJ, timeout=120,
            )
            if r.returncode != 0:
                return {"ok": False, "error": (r.stderr or "日报生成失败")[-600:]}
            res = {"ok": True, "data": json.loads(r.stdout)}
            _DIGEST_CACHE[days] = (time.time(), res)
            return {**res, "cached": False}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "日报生成超时"}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def price_ref(guid: str) -> dict:
    """调 price-ref.ts 拿报价参考 —— 下浮率配对与分位计算都在 lib/price-stats.ts。"""
    try:
        r = subprocess.run(
            ["node", "--no-warnings", "src/price-ref.ts", f"--g={guid}"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=PROJ, timeout=60,
        )
        if r.returncode != 0:
            return {"ok": False, "error": (r.stderr or "报价参考生成失败")[-500:]}
        return json.loads(r.stdout)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


ZIP_LIMIT_MB = 500


def zip_attachments(guid: str):
    """把该公告的附件打成 zip，返回临时文件路径。

    为什么写临时文件而不是内存 BytesIO：30 个附件合计 190 MB（有项目 30 个 PDF），
    整包在内存里组装会瞬间吃掉 400 MB+。写盘 + 分块发送，内存占用恒定，
    上限可以放到 500 MB。
    """
    if not guid or len(guid) < 8:
        return None, "缺少 guid"
    c = _ro()
    rows = _rows(
        c.cursor(),
        "SELECT attach_guid, filename, local_path, size_bytes FROM attachment "
        "WHERE announcement_guid = ? AND status = 'ok'",
        (guid,),
    )
    c.close()
    rows = [r for r in rows if r.get("local_path")]
    if not rows:
        return None, "本项目没有可下载的附件"

    total = sum(r.get("size_bytes") or 0 for r in rows)
    if total > ZIP_LIMIT_MB * 1024 * 1024:
        return None, f"附件合计 {total / 1048576:.0f} MB，超过 {ZIP_LIMIT_MB} MB 上限，请逐个下载"

    import zipfile

    # 临时文件放在 data 目录下，保证在工作区内
    tmpdir = os.path.join(PROJ, "data", "_tmp")
    os.makedirs(tmpdir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".zip", dir=tmpdir)
    os.close(fd)

    added = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        seen = set()
        for r in rows:
            fp = os.path.join(PROJ, "data", r["local_path"])
            if not os.path.exists(fp):
                continue
            name = r.get("filename") or os.path.basename(fp)
            base, ext = os.path.splitext(name)
            i = 1
            while name in seen:  # 同名附件加序号，否则 zip 里会互相覆盖
                name = f"{base}_{i}{ext}"
                i += 1
            seen.add(name)
            z.write(fp, name)
            added += 1

    if added == 0:
        os.unlink(tmp)
        return None, "附件文件在本地已丢失，请重新下载"
    return tmp, None


_FACTS_CACHE: dict = {}


def load_facts() -> dict | None:
    """读事实表（TS 生成的 data/agg/facts.json）。

    为什么在 TS 生成：中标公告（nature=2）与招标公告（nature=1）guid 完全不同，
    连不上；唯一能连的是归一化标题，而 normalizeTitle 是 TS 函数 ——
    在 Python 复刻就是第二套口径。
    """
    p = os.path.join(PROJ, "data", "agg", "facts.json")
    if not os.path.exists(p):
        return None
    m = os.path.getmtime(p)
    hit = _FACTS_CACHE.get("hit")
    if hit and hit[0] == m:
        return hit[1]
    with open(p, encoding="utf-8") as f:
        d = json.load(f)
    _FACTS_CACHE["hit"] = (m, d)
    return d


MARKET_KEYS = {"winner": "winner", "city": "city", "type": "type", "buyer": "buyer"}


def market(x: str = "winner", n: int = 1, city: str = "", ptype: str = "",
           since: str = "", until: str = "", limit: int = 500,
           seg: str = "", city_other: int = 0) -> dict:
    """事实表透视。n<5 的组照样返回，但带 n 让前端灰显 —— 不能悄悄丢掉。

    seg / city_other 是给矩阵下钻用的（默认空 = 老行为不变，_market_test.py 的 5 条断言不受影响）：
    - seg：按 segment 过滤（矩阵按 segment 算，下钻也必须按 segment 过滤，
      否则「市政 798」点进去只看到 441 条 —— 那是两套口径）
    - city_other：city 为空的记录（矩阵里那行叫「其他」）
    """
    d = load_facts()
    if not d:
        return {"ok": False, "error": "事实表不存在，请先跑 node --no-warnings src/agg-build.ts"}
    key = MARKET_KEYS.get(x)
    if not key:
        return {"ok": False, "error": f"x 只支持 {list(MARKET_KEYS)}"}

    facts = d["facts"]
    src = facts
    if city:
        src = [f for f in src if (f.get("city") or "") == city]
    if city_other:
        src = [f for f in src if not f.get("city")]
    if ptype:
        src = [f for f in src if (f.get("type") or "") == ptype]
    if seg:
        src = [f for f in src if (f.get("segment") or f.get("type") or "") == seg]
    if since:
        src = [f for f in src if (f.get("pubDate") or "") >= since]
    if until:
        src = [f for f in src if (f.get("pubDate") or "") <= until]

    import statistics

    agg: dict = {}
    for f in src:
        k = f.get(key)
        if not k:
            continue
        a = agg.get(k)
        if a is None:
            a = {"key": k, "n": 0, "cities": set(), "rates": [], "winSum": 0.0, "rates5": []}
            agg[k] = a
        a["n"] += 1
        if f.get("city"):
            a["cities"].add(f["city"])
        if f.get("rate") is not None:
            a["rates"].append(f["rate"])
        if f.get("winPrice"):
            a["winSum"] += f["winPrice"]

    rows = []
    for a in agg.values():
        rates = sorted(a["rates"])
        rows.append({
            "key": a["key"],
            "n": a["n"],
            "cities": len(a["cities"]),
            "cityList": sorted(a["cities"])[:8],
            "rateN": len(rates),
            "rateMed": round(statistics.median(rates), 4) if rates else None,
            "rateP25": round(rates[int(len(rates) * 0.25)], 4) if len(rates) >= 5 else None,
            "rateP75": round(rates[min(len(rates) - 1, int(len(rates) * 0.75))], 4) if len(rates) >= 5 else None,
            "winSum": a["winSum"] or None,
        })

    # 默认按次数降序 —— 不按下浮率排，否则 1 次中标的小样本会排到最前
    rows.sort(key=lambda r: (-r["n"], r["key"]))

    # 筛选项（前端下拉用）
    facets = {
        "cities": sorted({f["city"] for f in facts if f.get("city")}),
        "types": sorted({f["type"] for f in facts if f.get("type")}),
    }

    return {
        "ok": True,
        "meta": {
            "generatedAt": d.get("generatedAt"),
            "x": x,
            "total": len(facts),
            "filtered": len(src),
            "groups": len(rows),
            "source": d.get("source"),
        },
        "facets": facets,
        "rows": rows[: max(1, min(2000, limit))],
    }


MY_BIDS = os.path.join(PROJ, "data", "my-bids.json")
_MY_LOCK = threading.Lock()


def my_bids_list() -> dict:
    """我的投标记录。存文件不存库 —— server 的 index.db 连接是 query_only，
    而「我投过哪些标」是用户私有数据，本来也不该进公共数据底座。"""
    if not os.path.exists(MY_BIDS):
        return {"ok": True, "items": []}
    try:
        with open(MY_BIDS, encoding="utf-8") as f:
            return {"ok": True, "items": json.load(f)}
    except Exception as e:
        return {"ok": False, "error": f"读取失败: {e}"}


def my_bid_save(data: dict) -> dict:
    """upsert 一条。guid 为键；同 guid 重复提交即更新（同一个标只留最新报价）。"""
    guid = (data.get("guid") or "").strip()
    if not guid:
        return {"ok": False, "error": "缺少 guid"}
    with _MY_LOCK:
        cur = my_bids_list()
        items = cur.get("items") or []
        rec = {
            "guid": guid,
            "title": (data.get("title") or "").strip()[:120],
            "myPrice": data.get("myPrice"),
            "result": data.get("result") or "pending",
            "note": (data.get("note") or "").strip()[:200],
            "at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        }
        idx = next((i for i, x in enumerate(items) if x.get("guid") == guid), -1)
        if idx >= 0:
            items[idx] = rec
        else:
            items.append(rec)
        try:
            with open(MY_BIDS, "w", encoding="utf-8") as f:
                json.dump(items, f, ensure_ascii=False, indent=1)
        except Exception as e:
            return {"ok": False, "error": f"写入失败: {e}"}
        return {"ok": True, "item": rec, "count": len(items)}


def market_grid(since: str = "", until: str = "", x: str = "type") -> dict:
    """L1 矩阵：城市 × 行业 的格子。

    为什么新开函数而不是给 market() 加 x=grid 分支：
    data/_market_test.py 有 5 条断言打的都是 /api/market，顺手重构会静默改坏它。

    x 参数决定用哪一列做"行业"：
      type    = typeOfTitle 的 9 类（含 40% 的"其他"）
      segment = 补词后的细分（其他降到 ~25%）

    长尾城市（n<30）不折叠，但标 thin=True —— 合肥只有 10 条是**采集缺口**
    （405 条中标公告的正文实际是招标公告内容），折叠起来会掩盖问题。
    """
    d = load_facts()
    if not d:
        return {"ok": False, "error": "事实表不存在，请先跑 node --no-warnings src/agg-build.ts"}
    facts = d["facts"]
    if since:
        facts = [f for f in facts if (f.get("pubDate") or "") >= since]
    if until:
        facts = [f for f in facts if (f.get("pubDate") or "") <= until]

    import statistics

    key2 = "type" if x == "type" else "segment"
    agg: dict = {}       # (city, ty) -> {n, rates}
    cityTotal: dict = {}
    typeTotal: dict = {}
    for f in facts:
        city = f.get("city") or "其他"
        ty = f.get(key2) or f.get("type") or "其他"
        a = agg.get((city, ty))
        if a is None:
            a = {"n": 0, "rates": []}
            agg[(city, ty)] = a
        a["n"] += 1
        if f.get("rate") is not None:
            a["rates"].append(f["rate"])
        cityTotal[city] = cityTotal.get(city, 0) + 1
        typeTotal[ty] = typeTotal.get(ty, 0) + 1

    # 列：按总量降序，把"其他/未分类"永远放最后（它是兜底，不是一类业务）
    cols = sorted(typeTotal, key=lambda t: (t in ("其他", "未分类"), -typeTotal[t]))

    rows = []
    for city in sorted(cityTotal, key=lambda c: -cityTotal[c]):
        cells = []
        for ty in cols:
            a = agg.get((city, ty))
            if not a:
                cells.append({"t": ty, "n": 0, "rn": 0, "med": None})
                continue
            cells.append({
                "t": ty,
                "n": a["n"],
                "rn": len(a["rates"]),
                "med": round(statistics.median(a["rates"]), 4) if a["rates"] else None,
            })
        rows.append({
            "city": city,
            "total": cityTotal[city],
            "thin": cityTotal[city] < 30,
            "cells": cells,
        })

    filled = sum(1 for v in agg.values() if v["n"] > 0)
    rateCells = sum(1 for v in agg.values() if len(v["rates"]) >= 5)
    return {
        "ok": True,
        "meta": {
            "generatedAt": d.get("generatedAt"),
            "total": len(facts),
            "cells": len(agg),
            "rateCells": rateCells,
            "x": x,
        },
        "cols": cols,
        "rows": rows,
    }


def market_cell(city: str = "", seg: str = "", city_other: int = 0,
                since: str = "", until: str = "", ptype: str = "") -> dict:
    """L2 格子详情：一次返回 4 块（摘要 / Top20 / 下浮率分布 / 月度趋势）。

    为什么一次返回而不是三次请求：最大格的完整块约 1.2KB，
    拆三次 = 3×RTT + 3×重新扫 3,572 行，收益为负。
    聚合用**格内全量**，只有明细 rows 截到 200 —— 否则 235 条的格只看 200 条算中位会静默错数。
    """
    d = load_facts()
    if not d:
        return {"ok": False, "error": "事实表不存在"}
    facts = d["facts"]
    src = facts
    if city:
        src = [f for f in src if (f.get("city") or "") == city]
    if city_other:
        src = [f for f in src if not f.get("city")]
    if seg:
        src = [f for f in src if (f.get("segment") or f.get("type") or "") == seg]
    if ptype:
        src = [f for f in src if (f.get("type") or "") == ptype]
    if since:
        src = [f for f in src if (f.get("pubDate") or "") >= since]
    if until:
        src = [f for f in src if (f.get("pubDate") or "") <= until]

    import statistics

    # 摘要
    win = {}
    for f in src:
        w = f.get("winner")
        if w:
            win[w] = win.get(w, 0) + 1
    rates = [f["rate"] for f in src if f.get("rate") is not None]
    topN = max(win.values()) if win else 0
    brief = {
        "n": len(src),
        "winners": len(win),
        "topShare": round(topN / len(src), 4) if src else None,
        "rateN": len(rates),
        "rateMed": round(statistics.median(rates), 4) if rates else None,
    }

    # Top20（含每家的下浮率中位）
    top = []
    for w, n in sorted(win.items(), key=lambda x: -x[1])[:20]:
        rs = sorted(f["rate"] for f in src if f.get("winner") == w and f.get("rate") is not None)
        top.append({
            "key": w, "n": n, "rateN": len(rs),
            "rateMed": round(statistics.median(rs), 4) if rs else None,
        })

    # 下浮率 10 桶（0-5%, 5-10%, ... 45%+）
    hist = [0] * 10
    for r in rates:
        b = min(9, max(0, int(r * 100 // 5)))
        hist[b] += 1

    # 月度
    mons = {}
    for f in src:
        m = (f.get("pubDate") or "")[:7]
        if m:
            mons[m] = mons.get(m, 0) + 1
    months = [{"m": k, "n": v} for k, v in sorted(mons.items())]

    # 明细（截 200）
    rows = [{
        "guid": f["guid"], "title": f["title"], "winner": f.get("winner"),
        "pubDate": f.get("pubDate"), "winPrice": f.get("winPrice"),
        "ctrl": f.get("ctrl"), "rate": f.get("rate"),
    } for f in sorted(src, key=lambda x: (x.get("pubDate") or ""), reverse=True)[:200]]

    return {
        "ok": True,
        "meta": {"total": len(facts), "filtered": len(src)},
        "brief": brief,
        "top": top,
        "hist": hist,
        "months": months,
        "rows": rows,
        "truncated": max(0, len(src) - 200),
    }


def company_profile(w: str = "") -> dict:
    """L3 公司画像：中标曲线 / 活动半径 / 报价习惯 / 明细。

    **必须返回 rateN**：最大那家公司 31 单里只有 1 单能配对下浮率，
    前端若直接画"报价习惯 14.2%"，就是用一个样本冒充 31 单的行为特征。
    """
    d = load_facts()
    if not d:
        return {"ok": False, "error": "事实表不存在"}
    if not w:
        return {"ok": False, "error": "缺少 w（公司名）"}
    mine = [f for f in d["facts"] if f.get("winner") == w]
    if not mine:
        return {"ok": False, "error": f"没有「{w}」的中标记录（名字必须完全一致）"}

    import statistics

    rates = [f["rate"] for f in mine if f.get("rate") is not None]
    mons, cities = {}, {}
    for f in mine:
        m = (f.get("pubDate") or "")[:7]
        if m:
            mons[m] = mons.get(m, 0) + 1
        c = f.get("city") or "其他"
        cities[c] = cities.get(c, 0) + 1

    return {
        "ok": True,
        "name": w,
        "n": len(mine),
        "winSum": sum(f["winPrice"] for f in mine if f.get("winPrice")) or None,
        "cities": len(cities),
        "rateN": len(rates),
        "rateMed": round(statistics.median(rates), 4) if rates else None,
        "curve": [{"m": k, "n": v} for k, v in sorted(mons.items())],
        "cityDist": [{"c": k, "n": v} for k, v in sorted(cities.items(), key=lambda x: -x[1])],
        "rows": [{
            "guid": f["guid"], "title": f["title"], "pubDate": f.get("pubDate"),
            "city": f.get("city"), "winPrice": f.get("winPrice"),
            "ctrl": f.get("ctrl"), "rate": f.get("rate"),
        } for f in sorted(mine, key=lambda x: (x.get("pubDate") or ""), reverse=True)[:30]],
    }


def get_check_text(fn: str) -> dict:
    """取出这次检查时的标书原文（按行），用于点证据行号定位。"""
    if not fn or "/" in fn or "\\" in fn or not fn.endswith(".json"):
        return {"ok": False, "error": "非法文件名"}
    fp = os.path.join(CHECKS_DIR, fn[:-5] + ".txt")
    if not os.path.exists(fp):
        return {"ok": False, "error": "这次检查没有存原文（旧记录不支持定位）"}
    with open(fp, encoding="utf-8") as f:
        return {"ok": True, "lines": f.read().split("\n")}


def diff_checks(fa: str, fb: str) -> dict:
    """两次检查的差异：修好了哪些、改坏了哪些、还没动的。

    只比 state（covered/mentioned/missing），不比证据内容 ——
    「证据从 L120 换到 L135」不是改稿，是排版动了。
    """
    a = get_check(fa)
    b = get_check(fb)
    if not a.get("ok") or not b.get("ok"):
        return {"ok": False, "error": "文件不存在"}

    pa = a["data"]["data"] if "data" in a["data"] else {}
    pb = b["data"]["data"] if "data" in b["data"] else {}
    sa = {d["checkId"]: d for d in (pa.get("diagnoses") or [])}
    sb = {d["checkId"]: d for d in (pb.get("diagnoses") or [])}

    fixed, broke, still = [], [], []
    for cid, d in sa.items():
        e = sb.get(cid)
        if not e:
            continue
        x, y = d.get("state"), e.get("state")
        if x != "covered" and y == "covered":
            fixed.append({"id": cid, "title": d.get("title"), "from": x})
        elif x == "covered" and y != "covered":
            broke.append({"id": cid, "title": e.get("title"), "to": y})
        elif x != "covered" and y != "covered":
            still.append({"id": cid, "title": d.get("title"), "state": y})

    return {
        "ok": True,
        "a": {"time": a["data"].get("time"), "name": a["data"].get("name"), "summary": pa.get("summary")},
        "b": {"time": b["data"].get("time"), "name": b["data"].get("name"), "summary": pb.get("summary")},
        "fixed": fixed,
        "broke": broke,
        "still": still,
    }


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
            if p in ("/check", "/check.html"):
                return self._file(os.path.join(ROOT, "check.html"), "text/html; charset=utf-8")
            if p in ("/project", "/project.html"):
                return self._file(os.path.join(ROOT, "project.html"), "text/html; charset=utf-8")
            if p in ("/digest", "/digest.html"):
                return self._file(os.path.join(ROOT, "digest.html"), "text/html; charset=utf-8")
            if p == "/api/project":
                return self._send(project_detail(one("g", "")))
            if p == "/api/search":
                return self._send(search_projects(one("q", ""), int(one("limit", "20"))))
            if p == "/api/digest":
                return self._send(digest_json(int(one("days", "2"))))
            if p == "/api/price-ref":
                return self._send(price_ref(one("g", "")))
            if p == "/api/market":
                return self._send(market(
                    x=one("x", "winner"),
                    n=int(one("n", "1")),
                    city=one("city", ""),
                    ptype=one("type", ""),
                    since=one("since", ""),
                    until=one("until", ""),
                    limit=int(one("limit", "500")),
                    seg=one("seg", ""),
                    city_other=int(one("city_other", "0")),
                ))
            if p == "/api/my-bids":
                return self._send(my_bids_list())
            if p == "/api/market-grid":
                return self._send(market_grid(
                    since=one("since", ""),
                    until=one("until", ""),
                    x=one("x", "type"),
                ))
            if p == "/api/market-cell":
                return self._send(market_cell(
                    city=one("city", ""),
                    seg=one("seg", ""),
                    city_other=int(one("city_other", "0")),
                    since=one("since", ""),
                    until=one("until", ""),
                    ptype=one("type", ""),
                ))
            if p == "/api/company":
                return self._send(company_profile(one("w", "")))
            if p == "/api/attachments/zip":
                g0 = one("g", "")
                path, err = zip_attachments(g0)
                if err:
                    return self._send({"ok": False, "error": err}, 400)
                try:
                    size = os.path.getsize(path)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header(
                        "Content-Disposition",
                        'attachment; filename="attachments-%s.zip"' % (g0[:8] if g0 else "x"),
                    )
                    self.send_header("Content-Length", str(size))
                    self.end_headers()
                    # 分块发送：大文件不整个读进内存
                    with open(path, "rb") as f:
                        while True:
                            chunk = f.read(65536)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                finally:
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
                return
            if p == "/api/checks":
                return self._send(list_checks())
            if p == "/api/checks/get":
                return self._send(get_check(one("f", "")))
            if p == "/api/checks/text":
                return self._send(get_check_text(one("f", "")))
            if p == "/api/checks/diff":
                return self._send(diff_checks(one("a", ""), one("b", "")))
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

    def _file(self, fp, ctype):
        if not os.path.exists(fp):
            return self._send({"error": "文件不存在"}, 404)
        with open(fp, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        """技术标自检：body 是文件原始字节，参数走 query。"""
        u = urlparse(self.path)
        qs = parse_qs(u.query)

        def one(k, d=None):
            v = qs.get(k)
            return v[0] if v else d

        if u.path == "/api/my-bids":
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 1024 * 1024:
                return self._send({"ok": False, "error": "请求体为空或超过 1MB"}, 400)
            try:
                payload = json.loads(self.rfile.read(n).decode("utf-8", "replace"))
            except Exception as e:
                return self._send({"ok": False, "error": f"JSON 解析失败: {e}"}, 400)
            return self._send(my_bid_save(payload))

        if u.path != "/api/check":
            return self._send({"ok": False, "error": "未知接口"}, 404)

        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return self._send({"ok": False, "error": "文件为空"}, 400)
        if n > 64 * 1024 * 1024:
            return self._send({"ok": False, "error": "文件超过 64MB"}, 413)

        data = self.rfile.read(n)
        name = one("name", "upload.docx")
        guid = one("guid", "")
        ptype = one("projectType", "")
        title = one("title", "")

        res = run_check(data, name, guid, ptype, title)
        if res.get("ok"):
            try:
                saved = save_check(name, guid, ptype, res["data"], res.get("text") or "")
                res["file"] = os.path.basename(saved)
            except Exception:
                pass  # 存历史失败不影响这次结果
            res.pop("text", None)  # 原文太大，不回传给前端
        return self._send(res, 200 if res.get("ok") else 422)

if __name__ == "__main__":
    print(f"数据浏览器 → http://127.0.0.1:{PORT}/")
    print(f"技术标自检 → http://127.0.0.1:{PORT}/check")
    print(f"POST 支持：{hasattr(H, 'do_POST')}｜检查历史目录：{CHECKS_DIR}")
    print(f"数据库：{DB}")
    total = sum(t["rows"] for g in schema() for t in g["tables"])
    print(f"{len(ALLOWED)} 张表/视图，合计 {total:,} 行")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
