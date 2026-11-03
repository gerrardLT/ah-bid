"""按 zip 文件名关键词，反查有清单且已解析招标文件的项目 guid。只读。"""

import sqlite3
import sys

sys.stdout.reconfigure(encoding="utf-8")
c = sqlite3.connect("file:data/index.db?mode=ro", uri=True)

KEYS = ["军休", "一六八", "徽商", "工程量清单", "附件.zip"]

for k in KEYS:
    rows = c.execute(
        """
        SELECT d.attach_guid, a.title, t.filename
        FROM attachment t
        JOIN announcement a ON a.guid = t.announcement_guid
        LEFT JOIN tender_doc d ON d.announcement_guid = a.guid
        WHERE t.ext = '.zip' AND t.filename LIKE ?
        LIMIT 3
        """,
        (f"%{k}%",),
    ).fetchall()
    if not rows:
        continue
    print(f"=== 关键词「{k}」")
    for g, title, fn in rows:
        print(f"  guid={g}")
        print(f"    项目: {(title or '')[:44]}")
        print(f"    zip:  {(fn or '')[:46]}")
