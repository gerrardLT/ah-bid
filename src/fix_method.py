"""
只修复 evaluation_method（不重跑评分表提取）。

背景：METHOD_PATTERNS 缺了"独立标题行"写法时，235+ 份监理模板的评标办法
被抽成了正文引用句「按第三章评标办法"规定的方法」。
分值/评分表已正确入库，重跑全量提取要 4.7 小时（这批文件的 find_tables 很慢）；
而方法名只需要页文本，每份 1～2 秒。

复用 extract_tender 的 METHOD_PATTERNS（同一份规则，避免两处漂移）。
幂等：只更新 evaluation_method 仍含「规定的方法」的行。

用法：python fix_method.py [--limit=N]
"""
from __future__ import annotations

import re
import sqlite3
import sys

import fitz

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
fitz.TOOLS.mupdf_display_errors(False)

sys.path.insert(0, "D:/project/ah-bid/src")
import extract_tender as et  # noqa: E402

LIMIT = 0
for a in sys.argv[1:]:
    if a.startswith("--limit="):
        LIMIT = int(a.split("=", 1)[1])

DATA = "D:/project/ah-bid/data/"
conn = sqlite3.connect(DATA + "index.db")
cur = conn.cursor()

# 脏值判定：引用句碎片、章节名、带前缀未清洗、法律名。
# 不按长度判——“技术评分合理价格法”有 9 个字但完全正确。
DIRTY = (
    "evaluation_method IS NULL"
    " OR evaluation_method LIKE '%规定的方法%'"
    " OR evaluation_method LIKE '%中方法%'"
    " OR evaluation_method LIKE '%定标办法%'"
    " OR evaluation_method LIKE '%评标办法%'"
    " OR evaluation_method LIKE '%本招标项目%'"
    " OR evaluation_method LIKE '%本项目%'"
    " OR evaluation_method LIKE '（%'"
    " OR evaluation_method LIKE '(%'"
    " OR evaluation_method LIKE '%采用%'"
    " OR evaluation_method LIKE '%招标投标法%'"
    " OR evaluation_method LIKE '%中华人民共和国%'"
    # 合法方法名一定以「法」结尾；不以「法」结尾的是截断残留（如「一般计税方」）
    " OR evaluation_method NOT LIKE '%法'"
)
rows = cur.execute(
    f"SELECT attach_guid g, pdf_path p FROM tender_doc WHERE {DIRTY}"
).fetchall()
if LIMIT:
    rows = rows[:LIMIT]
print(f"待修复 {len(rows)} 份")

fixed = 0
still_bad = 0
for i, (g, p) in enumerate(rows, 1):
    try:
        doc = fitz.open(DATA + p)
        pages = [doc.load_page(k).get_text("text") for k in range(doc.page_count)]
        doc.close()
    except Exception as e:
        print(f"  [{i}/{len(rows)}] 打开失败：{e}")
        still_bad += 1
        continue

    full = "\n".join(pages)
    # 复用 extract_facts 的完整名称抽取逻辑（_verify_zero 已验证这条路径能抽出
    # 「综合评估法」），不再单独写一套正则。
    method = et.extract_facts(pages).get("evaluation_method")
    if method and ("规定的方法" in method or "中华人民共和国" in method or len(method) > 16):
        method = None  # 抽到的还是引用句垃圾或明显异常，不写回

    if method:
        cur.execute(
            "UPDATE tender_doc SET evaluation_method=? WHERE attach_guid=?", (method, g)
        )
        fixed += 1
        if fixed <= 10:
            print(f"  [{i}/{len(rows)}] {method}  {p[-46:]}")
    else:
        # 这类模板（“第3 章 评标办法前附表”）根本不写方法名称，
        # 正文直接就是评分细则。置 NULL 诚实表示“无名称”，
        # 甩掉引用句垃圾，让评标办法分布统计不再被污染。
        cur.execute(
            "UPDATE tender_doc SET evaluation_method=NULL WHERE attach_guid=?", (g,)
        )
        still_bad += 1

conn.commit()
print(f"\n修复 {fixed} 份，仍抽不到 {still_bad} 份")
left = cur.execute(
    "SELECT COUNT(*) FROM tender_doc WHERE evaluation_method LIKE '%规定的方法%'"
).fetchone()[0]
print(f"残留「规定的方法」：{left} 份")
conn.close()
