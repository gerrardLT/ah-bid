"""修复后验证：评标办法归一化、日期、下浮率样本量。只读。"""

import re
import sqlite3
import sys
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8")
c = sqlite3.connect("file:data/index.db?mode=ro", uri=True)


def norm_method(s):
    if not s:
        return "(null)"
    t = s
    for p in ["本项目", "本招标项目", "采用", "：", ":", "（", "(", "）", ")", "”", "“", '"', " ", "　"]:
        t = t.replace(p, "")
    t = t.strip()
    if "综合评估" in t or "综合评分" in t or "综合打分" in t or "综合评标" in t:
        return "综合评估法/综合评分法"
    if "最低价" in t or "最低投标" in t or "最低标价" in t or "次低价" in t or "低价排序" in t:
        return "最低价法类"
    if "合理低价" in t or "合理价格" in t:
        return "合理价格法类"
    if "定性" in t:
        return "定性定量法类"
    if "累进" in t or "迭代" in t:
        return "其他合法（累进/迭代）"
    return "其他/垃圾"


print("### evaluation_method 归一化分布")
cnt = Counter()
raw = Counter()
for (m,) in c.execute("SELECT evaluation_method FROM tender_doc"):
    cnt[norm_method(m)] += 1
    raw[m] += 1
total = sum(cnt.values())
for k, v in cnt.most_common():
    print(f"{k:22} {v:5}  {v / total * 100:5.1f}%")
print("distinct raw values:", len(raw))
print("\n剩余垃圾值样本（全部列出）：")
for k, v in raw.most_common():
    if norm_method(k) == "其他/垃圾":
        print(f"  {v:4}  {k!r}")

print("\n### pub_date 语义检查")
bad = c.execute(
    """SELECT COUNT(*) FROM announcement
       WHERE length(pub_date) >= 10
         AND (CAST(substr(pub_date,6,2) AS INT) > 12
              OR CAST(substr(pub_date,9,2) AS INT) > 31)"""
).fetchone()[0]
mx = c.execute("SELECT MAX(pub_date) FROM announcement").fetchone()[0]
print("非法日期:", bad, "| max(pub_date):", mx)

print("\n### tender_doc 分值覆盖")
row = c.execute(
    """SELECT COUNT(*),
              SUM(score_technical IS NOT NULL),
              SUM(score_verified)
       FROM tender_doc"""
).fetchone()
print(f"tender_doc {row[0]} 条，有技术分值 {row[1]}，已验证 {row[2]}")
