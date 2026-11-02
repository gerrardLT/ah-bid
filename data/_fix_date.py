"""修复被项目编号污染的 pub_date，并输出修复台账。

3 条省立医院公告的标题含「JG2026-32-0579」，旧正则把这个片段当成了发布日期。
真实月份从附件路径（attachments/<城市>/<年-月>/<guid>/）推断；
没有附件路径的置空，表示未知——不编造日期。
"""

import re
import sqlite3
import sys

sys.stdout.reconfigure(encoding="utf-8")
conn = sqlite3.connect("data/index.db")
cur = conn.cursor()

rows = cur.execute(
    """SELECT a.guid, a.pub_date, a.title, t.local_path
       FROM announcement a
       LEFT JOIN attachment t ON t.announcement_guid = a.guid
       WHERE a.pub_date LIKE '2026-3_-%'"""
).fetchall()

print(f"待修复 {len(rows)} 条")
for guid, bad, title, path in rows:
    m = re.search(r"/(\d{4}-\d{2})/", path or "")
    new = f"{m.group(1)}-01" if m else ""
    cur.execute("UPDATE announcement SET pub_date=? WHERE guid=?", (new, guid))
    print(f"  {bad} -> {new or '(空)'}  {title[:48]}")

conn.commit()

after = cur.execute(
    """SELECT COUNT(*) FROM announcement
       WHERE length(pub_date) >= 10
         AND (CAST(substr(pub_date,6,2) AS INT) > 12
              OR CAST(substr(pub_date,9,2) AS INT) > 31)"""
).fetchone()[0]
mx = cur.execute("SELECT MAX(pub_date) FROM announcement").fetchone()[0]
print(f"\n剩余语义非法日期：{after} 条；最新发布日期：{mx}")
conn.close()
