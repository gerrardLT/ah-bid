"""
从招标澄清文件提取「问答对」，并标记是否涉及评分/资格/工期变更。

为什么必须做：实测 80 份澄清文件里 20% 修改了评分标准、27.5% 改了资格条件。
而 scoring_item 是从原招标文件提取的，没有合并这些修改——
按过时规则写技术标会白写，漏掉放宽的条件会丢分。

结构（实测）：
    1. 问题描述……
       回复：答复内容……
或
    9. 问题描述……
       答：答复内容……
"""
import os, sys, re, json, sqlite3, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import fitz
fitz.TOOLS.mupdf_display_errors(False)

# 路径基于脚本位置推导，换机器/换目录不用改代码
DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data") + os.sep
db = sqlite3.connect(DATA + "index.db")
db.execute("PRAGMA busy_timeout=30000")
db.executescript("""
CREATE TABLE IF NOT EXISTS clarification_qa (
  attach_guid       TEXT NOT NULL,
  announcement_guid TEXT,
  title             TEXT,
  seq               INTEGER NOT NULL,
  question          TEXT,
  answer            TEXT,
  affects           TEXT,      -- 评分标准/资格条件/工期/清单/技术要求/延期（逗号分隔）
  extracted_at      TEXT NOT NULL,
  PRIMARY KEY (attach_guid, seq)
);
CREATE INDEX IF NOT EXISTS idx_cqa_ag ON clarification_qa(announcement_guid);
""")

AFFECT = {
    "评分标准": ["评分标准", "评分办法", "评审因素", "评分因素", "分值", "得分"],
    "资格条件": ["资格条件", "资质要求", "业绩要求", "投标人资格", "项目经理", "注册建造师"],
    "工期": ["工期", "日历天", "施工期"],
    "清单": ["工程量清单", "清单项", "项目特征"],
    "技术要求": ["技术要求", "技术标准", "技术规格", "参数要求"],
    "延期": ["延期", "推迟", "顺延", "投标截止时间"],
}

# 问答切分：编号 + 内容，直到「回复/答/答复」；答复到下一个编号或结尾
Q_RE = re.compile(
    r"(?:^|\n)\s*(\d{1,3})\s*[.、．]\s*([\s\S]{10,1500}?)(?=(?:回复|答复|答)\s*[：:])"
)
A_RE = re.compile(r"(?:回复|答复|答)\s*[：:]\s*([\s\S]{2,1200}?)(?=(?:\n\s*\d{1,3}\s*[.、．])|$)")

rows = db.execute("""
  SELECT a.attach_guid g, a.local_path p, an.title, m.announcement_guid ag
  FROM attachment a
  JOIN announcement_attachment m ON m.attach_guid = a.attach_guid
  JOIN announcement an ON an.guid = m.announcement_guid
  WHERE a.status='ok' AND a.ext='.pdf'
    AND (a.filename LIKE '%澄清%' OR a.filename LIKE '%补疑%' OR a.filename LIKE '%答疑%' OR a.filename LIKE '%更正%')
""").fetchall()
print(f"待处理澄清文件 {len(rows)} 份")

cur = db.cursor()
INS_SQL = """
INSERT INTO clarification_qa (attach_guid, announcement_guid, title, seq, question, answer, affects, extracted_at)
VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT(attach_guid, seq) DO UPDATE SET
  question=excluded.question, answer=excluded.answer, affects=excluded.affects, extracted_at=excluded.extracted_at
"""

now = time.strftime("%Y-%m-%dT%H:%M:%S")
ok = 0
fail = 0
qa_total = 0
affect_cnt = {k: 0 for k in AFFECT}
samples = []

for g, p, title, ag in rows:
    try:
        doc = fitz.open(DATA + p)
        text = "\n".join(doc[i].get_text() for i in range(doc.page_count))
        doc.close()
    except Exception:
        fail += 1
        continue

    text = re.sub(r"[ \t]+", " ", text)
    n = 0
    for m in Q_RE.finditer(text):
        q = re.sub(r"\s+", " ", m.group(2)).strip()
        rest = text[m.end():m.end() + 1400]
        am = A_RE.search(rest)
        a = re.sub(r"\s+", " ", am.group(1)).strip() if am else ""
        if len(q) < 8:
            continue
        joined = q + " " + a
        affects = [k for k, kws in AFFECT.items() if any(kw in joined for kw in kws)]
        cur.execute(INS_SQL, (g, ag, title, n, q[:800], a[:800], ",".join(affects) if affects else None, now))
        n += 1
        qa_total += 1
        for k in affects:
            affect_cnt[k] += 1
        if "评分标准" in affects and len(samples) < 3:
            samples.append((title[:30], q[:120], a[:160]))
    if n:
        ok += 1

db.commit()
print(f"成功解析 {ok} 份，失败 {fail} 份，提取问答对 {qa_total} 条\n")
print("涉及变更类型（可多选）：")
for k, v in sorted(affect_cnt.items(), key=lambda x: -x[1]):
    print(f"  {k:<8} {v:>5} 条问答")

print(f"\n{'='*70}\n修改了评分标准的样本\n{'='*70}")
for t, q, a in samples:
    print(f"\n  【{t}】\n    问：{q}\n    答：{a}")

stat = db.execute("SELECT COUNT(*) n, COUNT(DISTINCT announcement_guid) ag FROM clarification_qa").fetchone()
print(f"\nclarification_qa：{stat[0]} 条问答，覆盖 {stat[1]} 个公告")
db.close()
