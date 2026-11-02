"""
招标文件结构化提取器。

从「招标文件正文.pdf」里抽出写技术标和做报价都要用的硬事实：
  - 评标办法类型、分值构成（技术/商务/报价各多少分）
  - 详细评审的评分表（评分因素 / 分值 / 评分标准）
  - 招标控制价 / 合同估算价、计划工期
  - 各章节所在页码（评标办法 / 工程量清单 / 技术要求 / 图纸目录）

设计原则：
  - 只做定位与结构化，不做语义推断；抽不到就留 null，不做假数据。
  - 输出 JSON 到 stdout（UTF-8），由 Node 侧落库。
  - 金额、工期等保留原文片段，便于人工复核。

用法：
  python extract_tender.py <pdf路径> [--pretty]
"""

from __future__ import annotations

import json
import re
import sys

import fitz  # PyMuPDF

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# MuPDF 会把 "cannot find ExtGState resource" 这类修复性警告直接打到 stdout，
# 混在 JSON 前面会让调用方解析失败。关掉它，并把 JSON 用边界标记包起来，
# 就算库把别的日志写进 stdout 也不会破坏结果。
fitz.TOOLS.mupdf_display_errors(False)
JSON_BEGIN = "@@TENDER_JSON_BEGIN@@"
JSON_END = "@@TENDER_JSON_END@@"

# 章节关键词 → 定位页码
SECTION_PATTERNS = {
    "招标公告": [r"招标公告"],
    "投标人须知": [r"投标人须知"],
    "评标办法": [r"评标办法", r"评标及定标办法", r"评审办法"],
    "合同条款": [r"合同条款", r"合同主要条款"],
    "工程量清单": [r"工程量清单", r"分部分项工程量清单"],
    "图纸": [r"图纸", r"施工图纸", r"图纸目录"],
    "技术要求": [r"技术标准和要求", r"技术要求", r"技术规范"],
    "投标文件格式": [r"投标文件格式"],
}

WEIGHT_LABELS = {
    "technical": [r"技术(?:标|文件|部分)", r"施工组织设计"],
    "commercial": [r"商务(?:标|文件|部分)", r"资信(?:标|分|文件)"],
    "price": [r"报价(?:标|文件|部分)", r"投标报价"],
    # 安徽多个市把信用标单列为一项分值（实测 10 分），不在商务标里；
    # 少了它三项永远凑不成 100，会被误判为“文件没有分值构成”。
    "credit": [r"信用标", r"信用(?:分|评价)得分", r"企业信用"],
}

# 数字被排版空白拆开的情形（实测“商务标评审（8 0 分”）。合并规则要宽：
# 数字之间 1～6 个非数字、非“分”的字符一律删掉，只用于分值抽取的文本副本。
# 若只合并空白，遇到「（8 0 分」这种中间夹了别的字符的仍会漏。
SPLIT_NUM_RE = re.compile(r"(?<=\d)[^\d分]{1,6}(?=\d)")

def tights(t: str) -> str:
    """把数字之间的短间隙合并：“（8 0 分” → “（80 分”。"""
    return SPLIT_NUM_RE.sub("", re.sub(r"[ \t\u3000]+", " ", t))


MONEY_RE = re.compile(
    r"(?:招标控制价|最高投标限价|最高限价|合同估算价|预算金额)[^0-9]{0,20}"
    r"([0-9][0-9,，.]*)\s*(万元|元|万)",
)
# 工期写法很多：计划工期/合同工期/服务期限/合同履行期限…
# 实测只写“计划工期”只能盖住 2/34 份。
DURATION_RE = re.compile(
    r"(?:计划工期|工期要求|总工期|合同工期|服务期限|服务期|履行期限|工期)"
    r"[^0-9]{0,12}([0-9]{1,4})\s*(?:个)?(?:日历天|天|日)"
)
# 方法名的形态：0~12 个中文字 + 【评标语义词】 + 法。
# 用形态约束而不是白名单：安徽各地市的方法名很杂（动态合理价格法 / 智能筛查合理价格法 /
# 技术评分合理价格法 / 定性定量评审法 / 平均迭代法 / 差额定率累进法…），白名单必然漏。
# 反向好处：法律法规名（中华人民共和国招标投标法）、计税方法、评标办法 都不含这些语义词，
# 自然被排除——这是上一版用宽松正则时抽出一堆“中华人民共和国法”的原因。
METHOD_NAME = (
    r"([\u4e00-\u9fa5]{0,12}(?:评估|评分|打分|比价|低价|限价|价格|标价|定量|定性|迭代|累进|筛查|评审)法)"
)

METHOD_PATTERNS = [
    # ① 独立标题行：「第三章 评标办法」换行后接「综合评估法（2）」
    re.compile(
        r"第\s*[0-9一二三四五六七八九十]{1,3}\s*章\s*评\s*标\s*办\s*法"
        r"\s*\n?\s*(?:[（(]\s*\d\s*[）)])?\s*" + METHOD_NAME
    ),
    # ② 「评标办法（1）：综合评估法」
    re.compile(r"评标办法\s*(?:[（(]\d[）)])?\s*[：:]\s*" + METHOD_NAME),
    # ③ 「本项目采用综合评分法评标」
    re.compile(r"采用\s*[，、：:]?\s*" + METHOD_NAME),
]

# 命中即不是方法名：引用句碎片、章节名、法律法规名。
# 实测垃圾值：”规定的方法 / 中方法 / 及定标办法 / 评标办法 / 中华人民共和国招标投标法
BAD_METHOD = re.compile(
    r"规定的方法|中方法|及定标办法|和定标办法|评标办法|评标方法|本招标项目|本项目"
    r"|中华人民共和国|招标投标法|建筑法|合同法|计税方法|计算方法|办法$"
)
# 章节标题：用于划定一章的边界
CHAPTER_RE = re.compile(r"第\s*[0-9一二三四五六七八九十]{1,3}\s*[章节]")

# 章标题前面可能出现的交叉引用词——「符合第二章…」「按第三章…」不是章标题，是正文引用。
# 踩过的坑：p27 页首是表格内容「投标报价 | 符合第二章“投标人须知”第3.2 款规定」，
# CHAPTER_RE 命中「第二章」→ 误判为下一章开始 → 评标办法章节被截成只有 1 页，
# 其后的 p28~p29 评分表全部漏提（该文件评分条目从应有的 28 行降到 7 行）。
CITE_PREFIX_RE = re.compile(r"[符合按见依据照根据参见详见]\s*$")


def is_chapter_head(text: str) -> bool:
    """判断页首是否是真正的章标题，而不是正文里的交叉引用。"""
    head = text[:150]
    m = CHAPTER_RE.search(head)
    if not m:
        return False
    # 真章标题几乎在最前面（前面只有页码）
    if m.start() > 12:
        return False
    # 排除「符合第二章…」这类引用
    if m.start() > 0 and CITE_PREFIX_RE.search(head[: m.start()]):
        return False
    return True


def page_texts(doc: fitz.Document) -> list[str]:
    return [doc.load_page(i).get_text("text") for i in range(doc.page_count)]


def find_pages(pages: list[str], patterns: list[str]) -> list[int]:
    """返回命中页码（1 起）。"""
    out = []
    for i, t in enumerate(pages):
        if any(re.search(p, t) for p in patterns):
            out.append(i + 1)
    return out


def chapter_pages(pages: list[str], start_patterns: list[str], max_span: int = 45) -> list[int]:
    """
    把“命中关键词的页”扩成“整个章节的页范围”。

    两个坑都踩过了：
      1. 只取命中页 → 漏掉全部评分细则（细则在标题页之后几页）；
      2. 直接找章节起点 → 命中目录页（目录里写着“第三章 评标办法”），
         而下一页紧接就是“第四章…”，于是章节只剩一页，评分表全丢。

    做法：先过滤目录页，再“标题起点→下一个章标题”取整段，
    同时把非目录的命中页 ±2 并进来作保险，两者取并集。
    """

    def is_toc(text: str) -> bool:
        return len(CHAPTER_RE.findall(text[:4000])) >= 3 or text.count("....") > 6

    hits = [i for i, t in enumerate(pages) if any(re.search(p, t) for p in start_patterns)]
    body_hits = [i for i in hits if not is_toc(pages[i])]

    picked: set[int] = set()

    # 主策略：真章节标题 → 下一个不同章标题。
    # 不能只取 body_hits[0]：早期页（招标公告 / 投标人须知）也会出现
    # 「详见第三章评标办法」这种引用，那一页并不是章节起点。
    # 实测：某 62 页招标文件因此把评标办法章节算成只有 1 页，p28~p29 的
    # 评分表全部漏提（评分行从 28 行降到7 行）。
    # 改为：优先用 is_chapter_head 认定的真章标题作起点，每个都扫一遍取并集。
    starts = [i for i in body_hits if is_chapter_head(pages[i])] or body_hits
    for start in starts[:3]:
        end = min(start + max_span, len(pages)) - 1
        for j in range(start + 1, min(start + max_span, len(pages))):
            head = pages[j][:150]
            if is_chapter_head(pages[j]) and not any(re.search(p, head) for p in start_patterns):
                end = j - 1
                break
        picked |= set(range(start, end + 1))

    # 副策略：非目录命中页本身及其相邻页
    for i in body_hits:
        picked |= set(range(max(0, i - 2), min(len(pages), i + 3)))

    return sorted(p + 1 for p in picked)


def _collect_candidates(pages: list[str], scope: list[int] | None) -> dict[str, list[float]]:
    """在指定页范围（默认全书）内收集各类分值候选值。"""
    idx = [p - 1 for p in (scope or range(1, len(pages) + 1))]
    out: dict[str, list[float]] = {k: [] for k in WEIGHT_LABELS}
    for i in idx:
        if i < 0 or i >= len(pages):
            continue
        flat = tights(pages[i])
        for key, labels in WEIGHT_LABELS.items():
            for lab in labels:
                # 距离放宽到 16：实测“技术标评审（监理大纲）（”有 9 个字符
                for m in re.finditer(lab + r"[^0-9分]{0,16}([0-9]{1,3}(?:\.[0-9])?)\s*分", flat):
                    v = float(m.group(1))
                    if 0 < v <= 100 and v not in out[key]:
                        out[key].append(v)
    return out


def _combine(hits: dict[str, list[float]]) -> tuple[dict, str]:
    """
    从候选值里找出一组加起来等于 100 的分值。

    优先用齐四项（技术/商务/报价/信用），凑不出再退三项子集。
    “合计必须 = 100”是硬约束：宁可给空，不能给错。
    """
    keys = ["technical", "commercial", "price", "credit"]
    empty: dict[str, float | None] = {k: None for k in keys}

    def sum_ok(vals: list[float]) -> bool:
        return abs(sum(vals) - 100) <= 1

    # 四项全有候选 → 先按四项求解
    if all(hits[k] for k in keys):
        for t in hits["technical"][:6]:
            for c in hits["commercial"][:6]:
                for p in hits["price"][:6]:
                    for cr in hits["credit"][:6]:
                        if sum_ok([t, c, p, cr]):
                            return {"technical": t, "commercial": c, "price": p, "credit": cr}, "四项"

    # 三项子集
    import itertools

    for combo in itertools.combinations(["technical", "commercial", "price"], 3):
        if not all(hits[k] for k in combo):
            continue
        for a in hits[combo[0]][:8]:
            for b in hits[combo[1]][:8]:
                for c in hits[combo[2]][:8]:
                    if sum_ok([a, b, c]):
                        got = dict(empty)
                        got[combo[0]], got[combo[1]], got[combo[2]] = a, b, c
                        return got, "三项"

    # 两项（实测：监理大纲类项目只有“商务 80 + 技术 20”）
    for combo in itertools.combinations(keys, 2):
        if not all(hits[k] for k in combo):
            continue
        for a in hits[combo[0]][:8]:
            for b in hits[combo[1]][:8]:
                if sum_ok([a, b]):
                    got = dict(empty)
                    got[combo[0]], got[combo[1]] = a, b
                    return got, "两项"
    return empty, ""


def extract_score_weights(pages: list[str], eval_pages: list[int] | None = None) -> tuple[dict, list[str], str]:
    """
    抽 技术/商务/报价/信用 的分值构成。

    三道保险，每道都要求合计 100（容差 1）：
      1. 含“分值构成”的前附表，逐页直取；
      2. 章节内收集候选值，组合求解（支持四项/三项/两项——
         实测「监理大纲」类项目只有“商务 80 + 技术 20”两项）；
      3. 表格“分值”列（单元格只有数字、没有“分”字）。
    """
    keys = ["technical", "commercial", "price", "credit"]
    weights: dict[str, float | None] = {k: None for k in keys}

    # --- 第一道：前附表 ---
    for i, t in enumerate(pages):
        if "分值构成" not in t and "分值组成" not in t:
            continue
        flat = tights(t)
        got: dict[str, float | None] = {k: None for k in keys}
        for key, labels in WEIGHT_LABELS.items():
            for lab in labels:
                # 距离放宽到 16：实测“技术标评审（监理大纲）（”有 9 个字符
                m = re.search(lab + r"[^0-9]{0,16}([0-9]{1,3}(?:\.[0-9]+)?)\s*分", flat)
                if m:
                    got[key] = float(m.group(1))
                    break
        vals = [v for v in got.values() if v is not None]
        if len(vals) >= 2 and abs(sum(vals) - 100) <= 1:
            return got, [f"p{i + 1}（前附表）: {re.sub(r'\s+', ' ', t)[:160]}"], ""

    # --- 第二道：章节内组合求解 ---
    cand = _collect_candidates(pages, eval_pages)
    got, mode = _combine(cand)
    if got["technical"] is not None:
        return got, [
            f"组合求解（{mode}）：技术{got['technical']} 商务{got['commercial']} 报价{got['price']} 信用{got['credit']}"
            + f"；候选 技术{cand['technical'][:5]} 商务{cand['commercial'][:5]} 报价{cand['price'][:5]} 信用{cand['credit'][:5]}"
        ], "score_weights_from_combination"

    # --- 全部失败：留空，带候选回去供人工复核 ---
    ev = []
    if any(cand.values()):
        ev.append(
            f"未找到合计 100 的组合，候选：技术{cand['technical'][:6]} 商务{cand['commercial'][:6]} 报价{cand['price'][:6]} 信用{cand['credit'][:6]}"
        )
    return weights, ev, "score_weights_not_found"


def clean_method(raw: str) -> str | None:
    """把正则抓到的片段洗成方法名；不是像样的方法名就返回 None，交给下一个候选。"""
    s = re.sub(
        r"^(?:本项目)?(?:采用)?(?:评标办法|评标方法|评审办法)?\s*[：:]?\s*", "", raw
    ).strip(" 　：:（）()\"“”\n")
    s = re.sub(r"[（(]\d[）)]$", "", s).strip()
    if not s or len(s) > 24:
        return None
    if BAD_METHOD.search(s):
        return None
    if not s.endswith("法"):
        return None
    return s


def extract_facts(pages: list[str]) -> dict:
    full = "\n".join(pages)

    # 遍历所有模式的全部匹配，取第一个洗得干净的方法名。
    # 不能取第一个匹配就收——第一个匹配往往是正文引用句（“按第三章评标办法规定的方法”）。
    method = None
    for pat in METHOD_PATTERNS:
        for m in pat.finditer(full):
            raw = m.group(1) if m.lastindex else m.group(0)
            cand = clean_method(raw)
            if cand:
                method = cand
                break
        if method:
            break

    money = []
    for m in MONEY_RE.finditer(full):
        raw_num, unit = m.group(1), m.group(2)
        try:
            num = float(raw_num.replace(",", "").replace("，", ""))
        except ValueError:
            continue
        yuan = num * 10000 if unit in ("万元", "万") else num
        money.append({"label": m.group(0)[:20].strip(), "yuan": round(yuan, 2), "raw": m.group(0)[:40]})

    durations = sorted({int(m.group(1)) for m in DURATION_RE.finditer(full)})

    return {
        "evaluation_method": method,
        "money_facts": money[:6],
        "duration_days_candidates": durations[:6],
    }


def extract_scoring_tables(doc: fitz.Document, chapter: list[int], max_cell: int = 200) -> list[dict]:
    """
    取指定页范围内表头含“分值/评分/评审因素”的表格。
    只传章节页，不传全书 ——— 一本 200 页的招标文件有 200+ 个表，全扫既慢又噪。

    跨页续行：评分表常跨 2~4 页，**续页没有表头行**。
    如果只看 rows[0]，续页会被当成无关表格丢掉——实测某份 82 页招标文件，
    p40 的评分表（表头 ['评审内容','评分因素','分值','评分标准']）跨到 p41，
    p41 的 9 行数据全部丢失（其中包括“服务方案（大纲）20.0 分”及 5 个子项）。

    做法：记住上一个评分表的表头与列数；遇到同章节内、列数相近（±1）、
    且在紧邻 2 页内的无表头表格，判定为续页，沿用原表头收录。
    """
    out: list[dict] = []
    last_header: list[str] | None = None
    last_cols = 0
    last_page = -99

    for pno in sorted(chapter):
        try:
            tabs = doc.load_page(pno - 1).find_tables()
        except Exception:
            continue
        for t in tabs.tables:
            rows = t.extract()
            if not rows:
                continue
            head = " ".join(str(c or "") for c in rows[0])
            is_head = bool(re.search(r"分值|评分|评审因素|评审标准|得分", head))

            if is_head:
                last_header = [str(c or "").strip()[:40] for c in rows[0]]
                last_cols = len(rows[0])
                last_page = pno
                out.append(
                    {
                        "page": pno,
                        "header": last_header,
                        "rows": [[str(c or "").strip()[:max_cell] for c in r] for r in rows[1:40]],
                    }
                )
            elif (
                last_header is not None
                and abs(len(rows[0]) - last_cols) <= 1
                and pno - last_page <= 2
            ):
                # 续页：无表头，沿用上一个评分表的表头
                last_page = pno
                out.append(
                    {
                        "page": pno,
                        "header": last_header,
                        "rows": [[str(c or "").strip()[:max_cell] for c in r] for r in rows[:40]],
                        "continued": True,
                    }
                )
    return out


# 段落型评分点：句子边界 + 编号 + 评分因素 + （N 分）。
# 边界不能只认行首——实测子项常嵌在连续文本里：
#   “……不得分。2、设计要点及重难点（3 分）：设计思路明确……”
# 所以句号/分号也算边界；但名称里不允许再出现句号分号，防止跨句误匹配。
PARA_ITEM_RE = re.compile(
    r"(?:^|[\n\r\u2028\u2029]|[。；;！？]|分)\s*"
    r"(?:（\d{1,2}）|\(\d{1,2}\)|\d{1,2}[、．.]|[\u2460-\u2473])"
    r"\s*([^\n”“（）()：:。；;，,]{2,26}?)\s*[（(]\s*(\d{1,3}(?:\.\d+)?)\s*分\s*[）)]"
)


def extract_paragraph_scoring(pages: list[str], chapter: list[int]) -> list[dict]:
    """
    从评标办法章节的页文本里提取「段落型」评分点。

    形态三：评分标准不是表格，而是带编号的文字段落，例如：
        1、项目理解（5 分）：对港口镇全域土地综合整治的理解…
        2、设计要点及重难点（3 分）：设计思路明确…

    这类内容 find_tables() 拓不到（因为本来就不是表格），
    实测某份 82 页招标文件的「服务方案（大纲）20 分」下面 5 个子项全部漏提。
    """
    out: list[dict] = []
    seen: set[tuple[str, float]] = set()
    for pno in chapter:
        if pno - 1 >= len(pages):
            continue
        # PDF 提取会把一个词拆到两行（实测「设计要点及重难\n点（3 分）」），
        # 先把行内换行去掉再匹配，否则名称会被切断导致漏提。
        text = pages[pno - 1].replace("\n", "").replace("\r", "")
        for m in PARA_ITEM_RE.finditer(text):
            # 名称前可能残留分隔符（原文形如「（1）、项目监理班子组织形式」）
            name = re.sub(r"\s+", "", m.group(1)).strip().lstrip("、．.，,：:·・-")
            try:
                score = float(m.group(2))
            except ValueError:
                continue
            if len(name) < 2 or score <= 0 or score > 60:
                continue
            # 纯数字/纯标点的不是名字
            if re.fullmatch(r"[\d.%]+", name):
                continue
            key = (name, score)
            if key in seen:
                continue
            seen.add(key)
            out.append({"page": pno, "name": name, "score": score})
    return out


def weights_from_tables(doc: fitz.Document, chapter: list[int]) -> tuple[dict, str]:
    """
    从章节内的表格取分值：按表头找“分值”列，同一行里找“技术/商务/报价”标签。

    为什么需要这条：分值列的单元格里只有“20”，不带“分”字，
    用纯文本正则永远抽不到。必须按表格的结构去读列。
    """
    hits: dict[str, list[float]] = {k: [] for k in WEIGHT_LABELS}
    evidence = ""
    for pno in chapter:
        try:
            tabs = doc.load_page(pno - 1).find_tables()
        except Exception:
            continue
        for t in tabs.tables:
            rows = t.extract()
            if len(rows) < 2:
                continue
            header = [re.sub(r"\s+", "", str(c or "")) for c in rows[0]]
            val_col = next((i for i, h in enumerate(header) if re.search(r"分值|得分|权重|分值数", h)), None)
            if val_col is None:
                continue
            for row in rows[1:]:
                if len(row) <= val_col:
                    continue
                cells = [re.sub(r"\s+", "", str(c or "")) for c in row]
                cell_val = cells[val_col]
                m = re.search(r"([0-9]{1,3}(?:\.[0-9])?)", cell_val)
                if not m:
                    continue
                v = float(m.group(1))
                if not (0 < v <= 100):
                    continue
                # 同一行内任一单元格出现标签就算命中
                joined = " ".join(cells)
                for key, labels in WEIGHT_LABELS.items():
                    if any(re.search(lab, joined) for lab in labels) and v not in hits[key]:
                        hits[key].append(v)
                        if not evidence:
                            evidence = f"p{pno} 表格列取值：{joined[:110]}"
    if all(hits[k] for k in hits):
        got, mode = _combine(hits)
        if got["technical"] is not None:
            return got, f"{evidence}（{mode}）"
    return {k: None for k in WEIGHT_LABELS}, ""


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "缺少 PDF 路径"}, ensure_ascii=False))
        sys.exit(2)

    path = sys.argv[1]
    pretty = "--pretty" in sys.argv
    scoring_only = "--scoring-only" in sys.argv
    doc = fitz.open(path)
    try:
        pages = page_texts(doc)

        if scoring_only:
            # 只抽「评标办法」章节的评分表，单元格上限放宽到 1200 字（普通模式仍是 200）。
            # 为什么分开：现有 scoring_item 的消费者（tech-bid-scoring）按 200 字长度解析，
            # 突然变长会改变它已有的输出；而档位判断需要完整原文，所以走独立通道。
            chapter = chapter_pages(pages, SECTION_PATTERNS["评标办法"]) or find_pages(
                pages, SECTION_PATTERNS["评标办法"]
            )
            tables = extract_scoring_tables(doc, chapter, max_cell=1200)
            seen_names = set()
            for t in tables:
                for r in t.get("rows") or []:
                    for c in r:
                        seen_names.add(re.sub(r"\s+", "", str(c or "")))
            para = [
                p for p in extract_paragraph_scoring(pages, chapter) if p["name"] not in seen_names
            ]
            if para:
                tables.append(
                    {
                        "page": para[0]["page"],
                        "header": ["评分因素", "分值", "来源"],
                        "rows": [[p["name"], f'{p["score"]} 分', "段落"] for p in para],
                        "source": "paragraph",
                    }
                )
            print(JSON_BEGIN)
            print(
                json.dumps(
                    {"pdf": path, "pages": doc.page_count, "scoring_tables": tables},
                    ensure_ascii=False,
                )
            )
            print(JSON_END)
            return
        sections = {name: find_pages(pages, pats) for name, pats in SECTION_PATTERNS.items()}
        eval_pages = sections.get("评标办法") or []
        # 章节范围而不是命中页：评分细则通常在“评标办法”标题之后几页
        chapter = chapter_pages(pages, SECTION_PATTERNS["评标办法"]) or eval_pages
        weights, weight_evidence, weight_note = extract_score_weights(pages, chapter)
        facts = extract_facts(pages)
        tables = extract_scoring_tables(doc, chapter)

        # 形态三：段落型评分点（非表格）。
        # 上面表格里已经出现过的名字不重复计，避免同一评分点存两份。
        seen_names = set()
        for t in tables:
            for r in t.get("rows") or []:
                for c in r:
                    seen_names.add(re.sub(r"\s+", "", str(c or "")))
        para = [p for p in extract_paragraph_scoring(pages, chapter) if p["name"] not in seen_names]
        if para:
            tables.append(
                {
                    "page": para[0]["page"],
                    "header": ["评分因素", "分值", "来源"],
                    "rows": [[p["name"], f'{p["score"]} 分', "段落"] for p in para],
                    "source": "paragraph",
                }
            )

        # 第三道：从表格“分值”列取值（单元格里只有数字、没有“分”字的情形）
        if weights["technical"] is None:
            tw, tev = weights_from_tables(doc, chapter)
            if tw["technical"] is not None:
                weights = tw
                weight_note = "score_weights_from_table"
                weight_evidence = list(weight_evidence) + ([tev] if tev else [])

        text_chars = sum(len(t) for t in pages)
        # 均值低于每页 50 字就是扫描件，文本层不可信，必须显式标出来，
        # 否则上层会把它当成“这份招标文件没有评标办法”而不是“需要 OCR”。
        text_quality = "low" if doc.page_count and text_chars / doc.page_count < 50 else "ok"

        result = {
            "pdf": path,
            "pages": doc.page_count,
            "text_chars": text_chars,
            "text_quality": text_quality,
            "sections": {k: {"pages": v[:20], "count": len(v)} for k, v in sections.items() if v},
            "eval_chapter_pages": chapter[:40],
            "score_weights": weights,
            "score_weights_note": weight_note,
            "weight_evidence": weight_evidence,
            **facts,
            "scoring_tables": tables,
        }
        print(JSON_BEGIN)
        print(json.dumps(result, ensure_ascii=False, indent=2 if pretty else None))
        print(JSON_END)
    finally:
        doc.close()


if __name__ == "__main__":
    main()
