"""
中标结果结构化提取器（P1）v2。

从「中标候选人信息表」「评标情况一览表」PDF 里抽：
  - 第一中标候选人（中标人）、中标价（元）
  - 项目负责人、工期
  - 全部投标人报价区间（竞争强度）

实测的三个版式坑及修法：
  1. 表头不在 rows[0]：标题行（评标情况一览表/项目名称）占前两行，
     真表头（序号/投标单位/投标总报价）在第 3 行 → 在前 6 行内找表头行；
  2. 长表跨 4+ 页，续页首行是换行续名（「司」「有限公司」）且无表头 →
     列位置跨页延续，续名片段按"上一行未闭合则拼接"合并；
  3. 监理类项目只有两项分值（商务 80 + 技术 20），报价开标后才评 →
     组合求解支持两项。

输出 JSON 到 stdout（边界标记包裹），由 Node 侧落库。
"""
from __future__ import annotations

import json
import re
import sys

import fitz

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
fitz.TOOLS.mupdf_display_errors(False)

JSON_BEGIN = "@@BID_JSON_BEGIN@@"
JSON_END = "@@BID_JSON_END@@"

WINNER_RE = re.compile(r"第一中标候选人\s*[：:]\s*([^\n，,。；]{4,60})")
PRICE_RE = re.compile(r"([0-9][0-9,，]*(?:\.[0-9]{1,2})?)")
BIDDER_COUNT_RE = re.compile(r"接收投标文件的投标人总数为\s*(\d{1,4})")

HEADER_NAME = re.compile(r"投标单位|投标人名称|投标人")
HEADER_PRICE = re.compile(r"投标报价|投标总报价|报价（元）")
HEADER_SCORE = re.compile(r"综合得分")

CLOSED_SUFFIX = re.compile(
    r"(?:有限|有限责任)?公司$|集团$|研究院$|设计院$|事务所$|分公司$|中心$|大队$|经营部$|厂$|院$|所$|局$|处$"
)


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def extract_winner(pages: list[str]) -> str | None:
    full = re.sub(r"[ \t\u3000]+", "", "\n".join(pages))
    m = WINNER_RE.search(full)
    if not m:
        return None
    name = m.group(1).strip()
    name = re.split(r"中标候选人响应|资格能力条件", name)[0].strip()
    return name or None


def extract_kv_from_tables(doc: fitz.Document, max_page: int = 4) -> dict:
    """「中标候选人信息表」是键值对表格：值经常和键不在同一文本行，必须按表格读。"""
    out: dict[str, str | None] = {"leader": None, "duration": None}
    for pno in range(min(max_page, doc.page_count)):
        try:
            tabs = doc.load_page(pno).find_tables()
        except Exception:
            continue
        for t in tabs.tables:
            for row in t.extract():
                cells = [norm(str(c or "")) for c in row]
                joined = "".join(cells)
                if out["duration"] is None and "工期" in joined:
                    m = re.search(r"(\d{1,4})\s*日历天", joined)
                    if m:
                        out["duration"] = m.group(1)
                if out["leader"] is None and re.search(r"项目(?:负责人|经理)", joined):
                    m = re.search(r"姓名\s*([^\s]{2,20})", joined)
                    if m:
                        out["leader"] = m.group(1)
    return out


def locate_header(rows: list[list[str]]) -> tuple[int, int, int] | None:
    """
    在前 6 行里找同时含「投标单位」和「报价」的表头行。

    守卫：数据行也会命中“投标人”（如备注里的「投标人业绩」）+ 价格数字，
    会被误认成表头——但表头行的报价列是文字（投标报价（元）），
    数据行的报价列是纯数字。用这一点区分。
    """
    for i, row in enumerate(rows[:6]):
        cells = [norm(str(c or "")) for c in row]
        nc = next((j for j, x in enumerate(cells) if HEADER_NAME.search(x)), None)
        pc = next((j for j, x in enumerate(cells) if HEADER_PRICE.search(x)), None)
        if nc is None or pc is None:
            continue
        pc_cell = cells[pc]
        if re.search(r"^[0-9,，.]+$", pc_cell):
            continue  # 报价列是纯数字 → 这是数据行不是表头
        return i, nc, pc
    return None


def collect_rows(doc: fitz.Document) -> tuple[list[dict], int | None]:
    """
    收集评标长表的有序行（含换行续名片段），返回 (行列表, 综合得分列号)。

    每行: {name, price, score}；price/score 抽不到为 None。
    """
    out: list[dict] = []
    seen: set[str] = set()
    last_cols: tuple[int, int] | None = None
    score_col: int | None = None

    for pno in range(doc.page_count):
        try:
            tabs = doc.load_page(pno).find_tables()
        except Exception:
            continue
        for t in tabs.tables:
            rows = t.extract()
            if len(rows) < 2:
                continue

            head = locate_header(rows)
            if head:
                hrow, name_col, price_col = head
                score_col = next(
                    (
                        j
                        for j, x in enumerate([norm(str(c or "")) for c in rows[hrow]])
                        if HEADER_SCORE.search(x)
                    ),
                    None,
                )
                start = hrow + 1
            elif last_cols is not None:
                name_col, price_col = last_cols
                if len(rows[0]) <= max(name_col, price_col):
                    continue
                start = 0
            else:
                continue

            for row in rows[start:]:
                if len(row) <= max(name_col, price_col):
                    continue
                name = norm(str(row[name_col] or ""))
                price_m = PRICE_RE.search(norm(str(row[price_col] or "")))
                price = float(price_m.group(1).replace(",", "").replace("，", "")) if price_m else None
                score = None
                if score_col is not None and len(row) > score_col:
                    sm = re.search(r"([0-9]{1,3}(?:\.[0-9])?)", norm(str(row[score_col] or "")))
                    score = float(sm.group(1)) if sm else None
                if not name and price is None:
                    continue
                if name in seen and price is not None:
                    continue
                out.append({"name": name, "price": price, "score": score})
                if price is not None:
                    seen.add(name)

    return out, score_col


def merge_wrapped(rows: list[dict]) -> list[dict]:
    """
    合并被换行截断的名字。

    续行片段特征：无价格、名字很短（≤6 字）、上一行名字未闭合（不以
    公司/集团/院… 结尾）→ 拼接到上一行。
    """
    merged: list[dict] = []
    for r in rows:
        if (
            merged
            and r["price"] is None
            and r["name"]
            and len(r["name"]) <= 6
            and not CLOSED_SUFFIX.search(merged[-1]["name"])
        ):
            merged[-1]["name"] += r["name"]
            continue
        merged.append(dict(r))

    # 拼接后名字闭合、且有价格的才保留
    return [r for r in merged if r["price"] is not None and r["name"]]


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "缺少 PDF 路径"}, ensure_ascii=False))
        sys.exit(2)

    path = sys.argv[1]
    # --winner=名称：由调用方指定中标人（评标表本身没有“第一中标候选人”字段，
    # 中标人在另一份「中标候选人信息表」里，合并时需要传进来才能做价格锚定）。
    winner_override = None
    for a in sys.argv[2:]:
        if a.startswith("--winner="):
            winner_override = a.split("=", 1)[1].strip() or None

    if not path.lower().endswith(".pdf"):
        print(JSON_BEGIN)
        print(json.dumps({"pdf": path, "error": "非 PDF 文件，跳过"}, ensure_ascii=False))
        print(JSON_END)
        sys.exit(0)

    doc = fitz.open(path)
    try:
        pages = [doc.load_page(i).get_text("text") for i in range(doc.page_count)]
        winner = winner_override or extract_winner(pages)
        kv = extract_kv_from_tables(doc)
        raw_rows, _ = collect_rows(doc)
        bidders = merge_wrapped(raw_rows)
        # 全文压平（去空白）后的文本，供中标价文本锚定用
        flat = re.sub(r"\s+", "", "\n".join(pages))

        winner_price = None
        if winner:
            wflat = norm(winner)
            # 中标价用文本锚定而非表格匹配：表格检测对跨页/换行的方差太大，
            # 而中标人名称在全文里是唯一的 —— 最后一次出现（评标长表里的数据行）
            # 之后的第一个数字就是中标价。
            pos = flat.rfind(wflat)
            if pos < 0 and len(wflat) > 10:
                pos = flat.rfind(wflat[:10])
            if pos >= 0:
                seg = flat[pos + len(wflat) : pos + len(wflat) + 40]
                pm = PRICE_RE.search(seg)
                if pm:
                    try:
                        winner_price = float(pm.group(1).replace(",", "").replace("，", ""))
                    except ValueError:
                        pass

        # 表格匹配作为兑底（文本锚定失败时）
        if winner_price is None:
            wkey = norm(winner or "")
            if wkey:
                for b in bidders:
                    bn = norm(b["name"])
                    if bn.startswith(wkey[:8]) or wkey.startswith(bn[:8]):
                        winner_price = b["price"]
                        break

        prices = [b["price"] for b in bidders]
        confidence = "high" if winner and winner_price else ("medium" if winner or bidders else "low")

        result = {
            "pdf": path,
            "pages": doc.page_count,
            "winner": winner,
            "winner_price": winner_price,
            "leader": kv["leader"],
            "duration_days": kv["duration"],
            "bidder_count": len(bidders),
            "price_min": min(prices) if prices else None,
            "price_max": max(prices) if prices else None,
            "bidders": bidders[:40],
            "confidence": confidence,
        }
        print(JSON_BEGIN)
        print(json.dumps(result, ensure_ascii=False))
        print(JSON_END)
    finally:
        doc.close()


if __name__ == "__main__":
    main()
