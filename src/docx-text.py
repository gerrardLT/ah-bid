"""
从 .docx 抽纯文本，零第三方依赖（zipfile + xml.etree）。

为什么不用 python-docx：项目约定零依赖，而 docx 本质是 zip + XML，
正文在 word/document.xml 的 w:body 下，段落是 w:p，表格是 w:tbl。

表格处理：技术标里的进度表、机械表、人员表本身就是评分证据，
所以不能把表格拍平成一行文字——按行输出为 `a | b | c`，保留列边界。

用法：python src/docx-text.py <path.docx>
"""

import sys
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def para_text(p) -> str:
    """段落内所有文本节点拼接；tab / br 转成制表与换行。"""
    parts = []
    for node in p.iter():
        if not isinstance(node.tag, str):
            continue
        tag = node.tag[len(W):] if node.tag.startswith(W) else ""
        if tag == "t":
            parts.append(node.text or "")
        elif tag == "tab":
            parts.append("\t")
        elif tag == "br":
            parts.append(" ")
    return "".join(parts).strip()


def walk(el, out: list) -> None:
    for child in el:
        if not isinstance(child.tag, str):
            continue
        tag = child.tag[len(W):] if child.tag.startswith(W) else ""
        if tag == "p":
            t = para_text(child)
            if t:
                out.append(t)
        elif tag == "tbl":
            for tr in child.findall(W + "tr"):
                cells = []
                for tc in tr.findall(W + "tc"):
                    ps = [para_text(p) for p in tc.findall(W + "p")]
                    cells.append(" ".join(x for x in ps if x).strip())
                row = " | ".join(c for c in cells if c)
                if row:
                    out.append(row)
        elif tag in ("sdt", "sdtContent", "body"):
            walk(child, out)


def main() -> None:
    if len(sys.argv) < 2:
        print("用法：python src/docx-text.py <path.docx>", file=sys.stderr)
        sys.exit(2)

    path = sys.argv[1]
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile, OSError) as e:
        print(f"不是有效的 docx：{e}", file=sys.stderr)
        sys.exit(3)

    root = ET.fromstring(xml)
    body = root.find(W + "body")
    out: list[str] = []
    if body is not None:
        walk(body, out)

    sys.stdout.reconfigure(encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
