"""
扫描库内全部 zip，输出「含 Excel 的 zip」索引（JSON）。

为什么要单独一步：514 个 zip 里只有 24 个含 Excel，
直接对 514 个逐个启动解析器要 2.5 分钟，先筛一遍只要 20 秒。

输出：[{"path": "attachments/…/x.zip", "file": "x.zip", "excel": ["a.xls", …]}]
"""

import json
import os
import sqlite3
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")


def fix_name(n: str) -> str:
    try:
        return n.encode("cp437").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return n


c = sqlite3.connect("file:data/index.db?mode=ro", uri=True)
rows = c.execute(
    "SELECT local_path, filename FROM attachment WHERE ext='.zip' AND status='ok' AND local_path IS NOT NULL"
).fetchall()

out = []
for p, fname in rows:
    full = os.path.join("data", p)
    try:
        with zipfile.ZipFile(full) as zf:
            excel = [
                fix_name(i.filename)
                for i in zf.infolist()
                if i.filename.lower().endswith((".xls", ".xlsx"))
                and not i.filename.split("/")[-1].startswith("~$")
                and "__MACOSX" not in i.filename
            ]
    except Exception:
        continue
    if excel:
        out.append({"path": p, "file": fname, "excel": excel})

print(json.dumps(out, ensure_ascii=False))
