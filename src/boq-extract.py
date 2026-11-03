"""
工程量清单 Excel 解析：xls/xlsx → JSON（stdout）。

支持两种输入：
  python src/boq-extract.py <path.xls|path.xlsx>
  python src/boq-extract.py --zip=<a.zip> --entry=<zip 内路径>     ← 不落盘，直接读

设计前提（实测自 24 个含 Excel 的招标附件）：
  表头不是固定在第 1 行，常见「全费用综合单价表」在第 3 行，
  前面两行是标题和工程名称。所以先在前 12 行里找含「项目编码」的行当表头。

只认 9-12 位纯数字的编码 —— 这是国标清单编码的形态，
分部标题（「一、配电房电缆沟」）、合计行、备注行都会被自然排除。

输出：{ok: true, rows: [...], sheets: n} 或 {ok: false, error: "..."}
"""

from __future__ import annotations

import io
import json
import re
import sys
import zipfile

CODE_RE = re.compile(r"^\d{9,12}$")
CLEAN_RE = re.compile(r"[^0-9A-Za-z]")


def fix_name(n: str) -> str:
    """zip 内文件名常是 GBK，被当 cp437 解出来是乱码"""
    try:
        return n.encode("cp437").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return n


def cell_str(v) -> str:
    if v is None:
        return ""
    return re.sub(r"\s+", " ", str(v)).strip()


def extract_rows(data: list[list]) -> list[dict]:
    """从二维表里抽清单行；找不到表头就返回空。"""
    header_idx = None
    cols: dict[str, int] = {}

    for i, row in enumerate(data[:12]):
        cells = [cell_str(x) for x in row]
        joined = "|".join(cells)
        if "项目编码" in joined or ("项目名称" in joined and "单位" in joined):
            header_idx = i
            for j, c in enumerate(cells):
                if "编码" in c and "code" not in cols:
                    cols["code"] = j
                elif "名称" in c and "name" not in cols:
                    cols["name"] = j
                elif "特征" in c and "feature" not in cols:
                    cols["feature"] = j
                elif "单位" in c and "unit" not in cols:
                    cols["unit"] = j
                elif ("工程量" in c or "数量" in c) and "qty" not in cols:
                    cols["qty"] = j
            break

    if header_idx is None or "code" not in cols:
        return []

    def get(row: list, key: str) -> str:
        j = cols.get(key)
        if j is None or j >= len(row):
            return ""
        return cell_str(row[j])

    out: list[dict] = []
    for row in data[header_idx + 1 :]:
        code = CLEAN_RE.sub("", get(row, "code"))
        if not CODE_RE.match(code):
            continue
        qty_raw = get(row, "qty")
        try:
            qty = float(re.sub(r"[^\d.]", "", qty_raw) or 0)
        except ValueError:
            qty = 0.0
        out.append(
            {
                "code": code,
                "name": get(row, "name"),
                "feature": get(row, "feature")[:120],
                "unit": get(row, "unit"),
                "qty": qty,
            }
        )
    return out


def from_xlsx(src) -> tuple[list[dict], int]:
    """src 可以是路径，也可以是 BytesIO（从 zip 里直接读）"""
    import openpyxl

    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    rows: list[dict] = []
    n = 0
    for ws in wb.worksheets:
        n += 1
        data = [list(r) for r in ws.iter_rows(values_only=True)]
        rows.extend(extract_rows(data))
    wb.close()
    return rows, n


def from_xls(src) -> tuple[list[dict], int]:
    import xlrd

    if isinstance(src, bytes):
        wb = xlrd.open_workbook(file_contents=src)
    else:
        wb = xlrd.open_workbook(src)
    rows: list[dict] = []
    n = 0
    for sh in wb.sheets():
        n += 1
        data = [[sh.cell_value(i, j) for j in range(sh.ncols)] for i in range(sh.nrows)]
        rows.extend(extract_rows(data))
    return rows, n


def main() -> None:
    path = None
    zip_path = None
    entry = None
    for a in sys.argv[1:]:
        if a.startswith("--zip="):
            zip_path = a[6:]
        elif a.startswith("--entry="):
            entry = a[8:]
        elif not a.startswith("--"):
            path = a

    try:
        # 批量模式：不指定 entry 时，解析 zip 内全部 Excel（一次调用拿完，省掉进程启动开销）
        if zip_path and not entry:
            out = []
            with zipfile.ZipFile(zip_path) as zf:
                for info in zf.infolist():
                    raw = info.filename
                    if raw.endswith("/") or not raw.lower().endswith((".xls", ".xlsx")):
                        continue
                    base = raw.split("/")[-1]
                    # 跳过 Excel 锁文件与 macOS 元数据
                    if base.startswith("~$") or "__MACOSX" in raw:
                        continue
                    display = fix_name(raw)
                    try:
                        data = zf.read(raw)
                        src = io.BytesIO(data) if raw.lower().endswith(".xlsx") else data
                        rows, sheets = (from_xlsx(src) if raw.lower().endswith(".xlsx") else from_xls(src))
                        out.append({"entry": display, "ok": True, "sheets": sheets, "rows": rows})
                    except Exception as e:
                        out.append({"entry": display, "ok": False, "error": f"{type(e).__name__}: {e}"[:100]})
            print(json.dumps({"ok": True, "files": out}, ensure_ascii=False))
            return

        if zip_path and entry:
            with zipfile.ZipFile(zip_path) as zf:
                data = zf.read(entry)
            src = io.BytesIO(data) if entry.lower().endswith(".xlsx") else data
            rows, sheets = (from_xlsx(src) if entry.lower().endswith(".xlsx") else from_xls(src))
        elif path:
            rows, sheets = (from_xlsx(path) if path.lower().endswith(".xlsx") else from_xls(path))
        else:
            print(json.dumps({"ok": False, "error": "缺少路径"}))
            sys.exit(2)
    except Exception as e:  # 损坏文件、加密文件、格式不符都走这里
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return

    # 去重：同一编码可能出现在多个 sheet（分标段）
    seen = set()
    uniq = []
    for r in rows:
        key = (r["code"], round(r["qty"], 4))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(r)
    print(json.dumps({"ok": True, "rows": uniq, "sheets": sheets}, ensure_ascii=False))


if __name__ == "__main__":
    main()
