"""清掉最后一条截断方法名，并记录该 PDF 是否缺失（缺失是它没被重抽的原因）。"""

import os
import sqlite3
import sys

sys.stdout.reconfigure(encoding="utf-8")
c = sqlite3.connect("data/index.db")
rows = c.execute(
    "SELECT attach_guid, pdf_path, evaluation_method, length(evaluation_method) "
    "FROM tender_doc WHERE evaluation_method LIKE '%计税%'"
).fetchall()
for g, p, m, n in rows:
    exists = os.path.exists(os.path.join("data", p or ""))
    print(f"{g}  value={m!r} len={n}  pdf={p}  exists={exists}")

c.execute("UPDATE tender_doc SET evaluation_method = NULL WHERE evaluation_method LIKE '%计税%'")
c.commit()
print("cleared rows:", len(rows))

left = c.execute(
    """SELECT COUNT(*) FROM tender_doc
       WHERE evaluation_method IS NOT NULL
         AND (evaluation_method NOT LIKE '%法'
              OR evaluation_method LIKE '%中华人民共和国%'
              OR evaluation_method LIKE '%规定的方法%'
              OR evaluation_method LIKE '%计税%'
              OR length(evaluation_method) > 16)
    """
).fetchone()[0]
print("剩余非法方法名:", left)
c.close()
