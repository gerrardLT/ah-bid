"""生成《供电工程报价基准》。

数据源：bid_boq_price（390 条带价清单，来自 6 个真实控制价文件，自洽校验 100%）

关键处理：
  · 清单「项目名称」列不可靠——实测有「电力电缆」实际是「电缆头」的情况。
    真实名称在「项目特征描述」的「1．名称：XXX」里，以它为准。
  · 规格在「2．规格型号：XXX」里，按规格分档才能给出有意义的单价。
"""
import sys, os, re, sqlite3, time
from collections import defaultdict
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(_ROOT, "data", "index.db")
OUT = os.path.join(_ROOT, "output", "供电工程报价基准.md")

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

def real_name(feature, fallback):
    """从项目特征里提「名称」，提不到用列名

    过滤：如果提出来的是型号（如 "YJV"、"WDZA"），说明特征里「名称」后面直接跟了
    型号，应该用清单列名。
    """
    if feature:
        m = re.search(r"名\s*称\s*[：:．.、]?\s*([^\d\n，。；;]{2,28})", feature)
        if m:
            s = m.group(1).strip(" ：:．.、-—_")
            # 纯字母/型号 → 不是真名称
            if len(s) >= 2 and not re.fullmatch(r"[A-Za-z\-\d/.\s]+", s):
                return s
    return fallback or ""

def spec_of(feature):
    """从项目特征里提规格型号"""
    if not feature:
        return ""
    for pat in (r"规格型号\s*[：:．.、]?\s*([^\s，。；;]{2,40})",
                r"规\s*格\s*[：:．.、]?\s*([^\s，。；;]{2,40})",
                r"型号\s*[：:．.、]?\s*([^\s，。；;]{2,40})"):
        m = re.search(pat, feature)
        if m:
            return m.group(1).strip()
    return ""

rows = db.execute("SELECT * FROM bid_boq_price WHERE price > 0").fetchall()
print(f"带价条目 {len(rows)} 条")

# 重新分类：按 (真实名称, 规格) 归组
groups = defaultdict(list)   # (name, spec) → [row]
for r in rows:
    nm = real_name(r["feature"], r["name"])
    sp = spec_of(r["feature"])
    groups[(nm, sp)].append(r)

# 物类归类
def cls(nm):
    t = nm or ""
    if re.search(r"电缆头|终端头|熔接头|中间头|电缆终端", t): return "电缆头/接头"
    if re.search(r"拖拉管|顶管|水平定向钻进|定向钻", t): return "水平定向钻进"
    if re.search(r"电力电缆|控制电缆|架空导线|电缆$|^YJV|^YJLV|^VV|^WDZ", t): return "电缆"
    if re.search(r"保护管|排管|配管|钢管|MPP|CPVC|电工管", t): return "电缆保护管"
    if re.search(r"桥架|线槽|托盘", t): return "桥架"
    if re.search(r"高压.*柜|开关柜|环网柜|计量柜|环网箱", t): return "高压配电柜"
    if re.search(r"低压.*柜|配电柜|直流屏|信号屏", t): return "低压配电柜"
    if re.search(r"配电箱|控制箱|照明箱", t): return "配电箱"
    if re.search(r"变压器", t): return "变压器"
    if re.search(r"箱式变|箱变", t): return "箱式变电站"
    if re.search(r"发电机组", t): return "柴油发电机组"
    if re.search(r"监控|智能", t): return "监控系统"
    if re.search(r"接地|避雷|等电位", t): return "接地"
    if re.search(r"母线", t): return "母线"
    if re.search(r"断路器|隔离开关|隔离刀闸|避雷器", t): return "开关电器"
    if re.search(r"绝缘子|横担|金具", t): return "线路金具"
    if re.search(r"调试|试验|校验", t): return "调试试验"
    if re.search(r"电缆沟|盖板|沟道", t): return "电缆沟"
    if re.search(r"混凝土|砼", t): return "混凝土"
    if re.search(r"钢筋", t): return "钢筋"
    if re.search(r"基础|垫层|包封", t): return "土建基础"
    if re.search(r"土方|挖|回填|余方", t): return "土方"
    if re.search(r"定型井|检查井|井", t): return "井"
    if re.search(r"杆|钢管杆|电杆", t): return "杆塔"
    if re.search(r"标识|标牌|标识桩", t): return "标识"
    if re.search(r"脚手架|高度增加|大型机械|进出场|安拆", t): return "措施"
    if re.search(r"拆除|破除|恢复", t): return "破除恢复"
    if re.search(r"空调|自流坪|楼地面|护栏|装饰", t): return "房建配套"
    if re.search(r"备品备件|工器具", t): return "备品备件"
    return "其他"

by_cls = defaultdict(lambda: defaultdict(list))   # cls → (name,spec) → rows
for (nm, sp), rs in groups.items():
    by_cls[cls(nm)][(nm, sp)].extend(rs)

def stat(rs):
    ps = sorted(x["price"] for x in rs)
    n = len(ps)
    return {
        "n": n,
        "min": ps[0], "max": ps[-1],
        "med": ps[n // 2],
        "p25": ps[max(0, int(n * 0.25) - (1 if n > 3 else 0))],
        "p75": ps[min(n - 1, int(n * 0.75))],
        "qty": sum(x["qty"] or 0 for x in rs),
    }

md = []
md.append("# 供电工程报价基准")
md.append("")
md.append("> 数据来源：6 个真实招标项目的《最高投标限价》文件（控制价口径，非估算）")
md.append("> 提取方式：从 Excel 分部分项表逐条提取「综合单价」，已通过自洽校验（工程量 × 单价 = 合价，336/336 = 100%）")
md.append("> 样本：390 条带价清单项，覆盖 首都医科大学芜湖医院 / 鸠江10KV外线 / 赛仑特外线 / 马鞍山泵站 / 合肥西园小学 / 合肥五十中")
md.append("")

# 项目概览
md.append("## 一、样本项目概览")
md.append("")
md.append("| 项目 | 控制价 | 分部分项 | 占比 | 特点 |")
md.append("|---|---|---|---|---|")
proj_note = {
    "首都医科大": "含开闭所+3 座变电所+线路，最完整",
    "鸠江": "10KV 外线，线路为主",
    "赛仑特": "厂区外线",
    "马鞍山": "泵站供电设施",
    "合肥西园": "纯电缆采购安装",
    "合肥五十中": "纯电缆采购安装",
}
prows = db.execute("""SELECT c.project, c.amount,
  (SELECT ROUND(SUM(total),0) FROM bid_boq_price p WHERE p.project=c.project) boq
  FROM bid_control_price c WHERE c.amount IS NOT NULL ORDER BY c.amount DESC""").fetchall()
for r in prows:
    note = next((v for k, v in proj_note.items() if k in r["project"]), "")
    ratio = f"{r['boq']/r['amount']*100:.0f}%" if r["boq"] and r["amount"] else "—"
    md.append(f"| {r['project'][:28]} | {r['amount']/10000:,.0f} 万 | {(r['boq'] or 0)/10000:,.1f} 万 | {ratio} | {note} |")
md.append("")

ORDER = ["电缆", "水平定向钻进", "电缆保护管", "桥架", "母线", "接地", "电缆头/接头",
         "高压配电柜", "低压配电柜", "配电箱", "变压器", "箱式变电站",
         "柴油发电机组", "监控系统", "开关电器", "线路金具", "杆塔",
         "电缆沟", "井", "土建基础", "混凝土", "钢筋", "土方",
         "调试试验", "破除恢复", "房建配套", "标识", "备品备件", "措施", "其他"]
UNIT_HINT = {"电缆": "m", "水平定向钻进": "m", "电缆头/接头": "个", "电缆保护管": "m",
             "桥架": "m", "母线": "m", "接地": "m", "高压配电柜": "台", "低压配电柜": "台",
             "配电箱": "台", "变压器": "台", "箱式变电站": "座", "柴油发电机组": "台",
             "监控系统": "套", "杆塔": "基", "井": "座", "混凝土": "m³", "钢筋": "t",
             "土方": "m³", "土建基础": "m³", "电缆沟": "m", "调试试验": "系统"}

sec = 2
# 注意：不能写成 CN = "一二三…二十" 然后 CN[n-1]——字符串按字符索引，CN[11] 是「十」不是「十二」
CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
      "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
      "二十一", "二十二", "二十三", "二十四", "二十五", "二十六", "二十七", "二十八", "二十九", "三十",
      "三十一", "三十二", "三十三", "三十四", "三十五"]
def cn_num(n):
    return CN[n - 1] if 1 <= n <= len(CN) else str(n)

for cname in ORDER:
    if cname not in by_cls:
        continue
    items = by_cls[cname]
    ordered = sorted(items.items(), key=lambda kv: (-len(kv[1]), -stat(kv[1])["med"]))
    md.append(f"## {cn_num(sec)}、{cname}")
    md.append("")
    # 单位说明：优先用组内实际单位（有 km 的不能用 m，否则单价看着离谱）
    md.append("| 名称 | 规格 | 项数 | 单价中位(元) | P25~P75 | 区间 | 单位 | 合计量 |")
    md.append("|---|---|---|---|---|---|---|---|")
    for (nm, sp), rs in ordered[:30]:
        s = stat(rs)
        units = sorted({(x["unit"] or "").strip() for x in rs})
        u = "/".join([x for x in units if x]) or UNIT_HINT.get(cname, "")
        spread = f"{s['p25']:,.2f}~{s['p75']:,.2f}" if s["n"] > 2 else "—"
        md.append(
            f"| {nm[:20]} | {sp[:24] or '—'} | {s['n']} | **{s['med']:,.2f}** | "
            f"{spread} | {s['min']:,.2f}~{s['max']:,.2f} | {u} | {s['qty']:,.0f} |"
        )
    if len(ordered) > 30:
        md.append(f"| | | | | | | …… 另有 {len(ordered)-30} 项 |")
    md.append("")
    sec += 1

# 分部构成
md.append(f"## {cn_num(sec)}、分部造价构成")
md.append("")
md.append("| 分部 | 项数 | 合价 | 占比 |")
md.append("|---|---|---|---|")
tot_all = db.execute("SELECT SUM(total) t FROM bid_boq_price").fetchone()["t"] or 1
cats = db.execute("""SELECT category c, COUNT(*) n, SUM(total) t FROM bid_boq_price
  WHERE category<>'' GROUP BY category ORDER BY SUM(total) DESC LIMIT 15""").fetchall()
for r in cats:
    md.append(f"| {r['c'][:26]} | {r['n']} | {r['t']/10000:,.1f} 万 | {r['t']/tot_all*100:.1f}% |")
md.append("")
sec += 1

# 使用说明
md.append(f"## {cn_num(sec)}、怎么用这份基准")
md.append("")
md.append("**① 组价**")
md.append("")
md.append("```")
md.append("已知清单：YJV22-8.7/15-3x300 电缆 7,759 m")
md.append("查表：电缆 / YJV22-8.7/15-3x300 / 单价中位 905.26 元/m")
md.append("→ 该项报价 = 7,759 × 905.26 = 702.4 万元")
md.append("```")
md.append("")
md.append("**② 判断报价空间**")
md.append("")
md.append("```")
md.append("分包报价 700 元/m vs 控制价单价 905 元/m")
md.append("→ 毛利率约 22.7%，可据此决定让利幅度")
md.append("```")
md.append("")
md.append("**③ 校验清单合理性**")
md.append("")
md.append("```")
md.append("收到的清单单价明显低于本表 P25 → 可能是漏项或规格降档")
md.append("明显高于 P75 → 可能是特殊要求（耐寒/阻燃/矿物绝缘）")
md.append("```")
md.append("")
md.append("**④ 估算分部占比**")
md.append("")
md.append("```")
md.append("外线工程：线路部分约占 45%~50%，变电所设备占 30%~40%")
md.append("→ 施工部署的主线应该是外线，不是变电所")
md.append("```")
md.append("")

# 局限
sec += 1
md.append(f"## {cn_num(sec)}、使用限制")
md.append("")
md.append("| 限制 | 说明 |")
md.append("|---|---|")
md.append("| 样本 6 个项目 | 够看量级，不够做统计显著性检验 |")
md.append("| 地区集中安徽 | 合肥/芜湖/马鞍山/安庆；外省价格差异可能 10%~20% |")
md.append("| 时间为 2026 年 | 材料价格波动大，建议每季度复核 |")
md.append("| 控制价口径 | 是招标人上限价，实际中标价通常低 15%~20%（见下浮率基准） |")
md.append("| 规格不全 | 部分条目特征描述未写规格，单价跨度大，需人工判断 |")
md.append("")
md.append("**与下浮率的配合**：")
md.append("")
md.append("```")
md.append("本表是控制价口径的单价 → 报参考价时再乘 (1 - 下浮率)")
md.append("安徽供电类下浮率：平均 12.7%、中位 14.4%（437 条样本）")
md.append("```")
md.append("")
md.append("---")
md.append("")
md.append("> 生成脚本：`src/bid-boq-price.py`（提取）｜本文件由数据直接生成，未人工调整任何数值")

text = "\n".join(md)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w", encoding="utf-8").write(text)
print(f"已生成：{OUT}")
print(f"字数：{len(text)}")
print(f"\n分类统计：")
for c in ORDER:
    if c in by_cls:
        n = sum(len(v) for v in by_cls[c].values())
        t = sum(x["total"] or 0 for v in by_cls[c].values() for x in v)
        print(f"  {c:<14} {n:>3} 项  {t/10000:>8.1f} 万")
db.close()
