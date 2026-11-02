"""
扫描件/矢量型 PDF 的评分表 OCR 提取。

背景：这 2 份文件文本层为 0 字、图片为 0 张，但有 47~746 个矢量绘图——
文字被转成了路径（防复制）。get_pixmap 能正常渲染，所以可以走 OCR。

策略：全书 OCR 太慢（6 秒/页 × 204 页 = 20 分钟），
先 OCR 目录页定位「评标办法」章节页码，再只 OCR 那一小段。

用法：python src/ocr_scoring.py <pdf相对路径> [--scan=1..20] [--range=40..60]
"""
import os, sys, re, time, io
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import fitz
fitz.TOOLS.mupdf_display_errors(False)

PDF = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", sys.argv[1])
SCAN = None
RANGE = None
for a in sys.argv[2:]:
    if a.startswith("--scan="):
        SCAN = [int(x) for x in a.split("=", 1)[1].split("..")]
    elif a.startswith("--range="):
        RANGE = [int(x) for x in a.split("=", 1)[1].split("..")]

import easyocr
reader = easyocr.Reader(["ch_sim", "en"], gpu=False, verbose=False)

doc = fitz.open(PDF)
n = doc.page_count
print(f"{n} 页")

def ocr_page(pno: int) -> str:
    pix = doc.load_page(pno - 1).get_pixmap(dpi=150)
    res = reader.readtext(pix.tobytes("png"), detail=0, paragraph=False)
    return " ".join(res)

lo, hi = (SCAN if SCAN else [1, min(12, n)])
if RANGE:
    lo, hi = RANGE
print(f"\n=== OCR p{lo}~p{hi} ===")
t0 = time.time()
texts = {}
for pno in range(lo, hi + 1):
    texts[pno] = ocr_page(pno)
    hit = "评标办法" in texts[pno] or "评分标准" in texts[pno] or "分值" in texts[pno]
    print(f"  p{pno} [{len(texts[pno])}字] {'★' if hit else ''} {texts[pno][:90]}")
print(f"耗时 {time.time()-t0:.0f}s")

# 从目录里找「第X章 评标办法」对应的页码
print("\n=== 目录中的章节页码 ===")
for pno, t in texts.items():
    for m in re.finditer(r"第\s*([一二三四五六七八九十]+)\s*章\s*([^\d]{2,20}?)\s*[.．…\s]{2,}(\d{1,3})", t):
        print(f"  p{pno}: 第{m.group(1)}章 {m.group(2).strip()} → 第 {m.group(3)} 页")

# 提取评分点：复用 extract_tender 的正则，保证与文本版口径一致
if RANGE:
    src = open("src/extract_tender.py", encoding="utf-8").read()
    ns = {"__name__": "et"}
    exec(compile(src.split("def main(")[0], "et", "exec"), ns)
    pages = [texts.get(i, "") for i in range(1, n + 1)]
    items = ns["extract_paragraph_scoring"](pages, list(range(lo, hi + 1)))
    print(f"\n=== 段落型评分点 {len(items)} 个 ===")
    total = 0
    for it in items:
        total += it["score"]
        print(f"  p{it['page']:>3}  {it['name']:<24} {it['score']} 分")
    print(f"  合计 {total} 分")
    # 再试「得 N 分」/「XX（N 分）」这两种文本写法
    pat = re.compile(r"([\u4e00-\u9fa5A-Za-z]{2,16})\s*[（(]\s*(\d{1,2}(?:\.\d+)?)\s*分\s*[）)]")
    extra = {}
    for pno in range(lo, hi + 1):
        for m in pat.finditer(texts.get(pno, "")):
            name, sc = m.group(1), float(m.group(2))
            if 0 < sc <= 60:
                extra.setdefault((name, sc), pno)
    print(f"\n=== 括号分值型 {len(extra)} 个 ===")
    for (name, sc), pno in list(extra.items())[:30]:
        print(f"  p{pno:>3}  {name:<24} {sc} 分")
doc.close()
