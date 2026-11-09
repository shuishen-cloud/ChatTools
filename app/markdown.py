"""服务端 Markdown → HTML（用于分享页与 HTML 导出）。

与前端 static/markdown.js 保持同样的安全模型：
先转义，再生成受控标签；不支持原始 HTML 直通。
"""
from __future__ import annotations

import html
import re

_FENCE = re.compile(r"^\s*(```+|~~~+)\s*([\w+-]*)\s*$")
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_UL = re.compile(r"^\s*[-*+]\s+(.*)$")
_OL = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_TASK = re.compile(r"^\s*[-*+]\s+\[([ xX])\]\s+(.*)$")
_QUOTE = re.compile(r"^\s*>\s?(.*)$")
_HR = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?[\s:-]+\|[\s:|-]*$")


def _inline(raw: str) -> str:
    s = html.escape(raw, quote=True)

    codes: list[str] = []

    def stash(m: re.Match) -> str:
        codes.append(m.group(1))
        return f"\x01{len(codes) - 1}\x01"

    s = re.sub(r"`([^`\n]+)`", stash, s)

    def img(m: re.Match) -> str:
        alt, url = m.group(1), m.group(2)
        if not re.match(r"^(https?://|data:image/)", url, re.I):
            return m.group(0)
        return f'<img class="md-img" src="{url}" alt="{alt}" loading="lazy">'

    s = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)\)", img, s)

    def link(m: re.Match) -> str:
        label, url = m.group(1), m.group(2)
        if not re.match(r"^(https?://|mailto:|/|#)", url, re.I):
            return label
        ext = ' target="_blank" rel="noopener noreferrer"' \
            if re.match(r"^https?://", url, re.I) else ""
        return f'<a href="{url}"{ext}>{label}</a>'

    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, s)
    s = re.sub(r"(^|[\s(])(https?://[^\s<)\"]+)",
               lambda m: f'{m.group(1)}<a href="{m.group(2)}" target="_blank" '
                         f'rel="noopener noreferrer">{m.group(2)}</a>', s)
    s = re.sub(r"\*\*\*([^*]+)\*\*\*", r"<strong><em>\1</em></strong>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(^|[^*])\*([^*\n]+)\*", r"\1<em>\2</em>", s)
    s = re.sub(r"~~([^~]+)~~", r"<del>\1</del>", s)
    s = re.sub(r"\x01(\d+)\x01", lambda m: f"<code>{codes[int(m.group(1))]}</code>", s)
    return s


def _code_block(raw: str, lang: str) -> str:
    safe = html.escape(raw, quote=True)
    label = f'<div class="code-lang">{html.escape(lang)}</div>' if lang else ""
    return (f'<div class="code-wrap">{label}'
            f'<pre><code>{safe}</code></pre></div>')


def render(src: str | None) -> str:
    if src is None:
        return ""
    lines = str(src).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    para: list[str] = []

    def flush() -> None:
        if para:
            out.append("<p>" + "<br>".join(_inline(x) for x in para) + "</p>")
            para.clear()

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]

        fence = _FENCE.match(line)
        if fence:
            flush()
            mark, lang = fence.group(1), fence.group(2)
            body: list[str] = []
            i += 1
            close = re.compile(r"^\s*" + re.escape(mark[0] * 3))
            while i < n and not close.match(lines[i]):
                body.append(lines[i])
                i += 1
            i += 1
            out.append(_code_block("\n".join(body), lang))
            continue

        if not line.strip():
            flush()
            i += 1
            continue

        h = _HEADING.match(line)
        if h:
            flush()
            lv = len(h.group(1))
            out.append(f'<h{lv} class="md-h">{_inline(h.group(2))}</h{lv}>')
            i += 1
            continue

        if _HR.match(line):
            flush()
            out.append("<hr>")
            i += 1
            continue

        if _QUOTE.match(line):
            flush()
            quote: list[str] = []
            while i < n and _QUOTE.match(lines[i]):
                quote.append(_QUOTE.match(lines[i]).group(1))  # type: ignore[union-attr]
                i += 1
            out.append(f"<blockquote>{render(chr(10).join(quote))}</blockquote>")
            continue

        if _TASK.match(line):
            flush()
            items = []
            while i < n:
                t = _TASK.match(lines[i])
                if not t:
                    break
                done = t.group(1).lower() == "x"
                items.append(
                    f'<li class="task{" done" if done else ""}">'
                    f'<span class="box">{"✓" if done else ""}</span>'
                    f'{_inline(t.group(2))}</li>')
                i += 1
            out.append('<ul class="tasklist">' + "".join(items) + "</ul>")
            continue

        if _UL.match(line):
            flush()
            items = []
            while i < n and _UL.match(lines[i]) and not _TASK.match(lines[i]):
                items.append(f"<li>{_inline(_UL.match(lines[i]).group(1))}</li>")  # type: ignore[union-attr]
                i += 1
            out.append("<ul>" + "".join(items) + "</ul>")
            continue

        if _OL.match(line):
            flush()
            items = []
            while i < n and _OL.match(lines[i]):
                items.append(f"<li>{_inline(_OL.match(lines[i]).group(1))}</li>")  # type: ignore[union-attr]
                i += 1
            out.append("<ol>" + "".join(items) + "</ol>")
            continue

        if "|" in line and i + 1 < n and _TABLE_SEP.match(lines[i + 1]):
            flush()

            def cells(row: str) -> list[str]:
                return [c.strip() for c in row.strip().strip("|").split("|")]

            head = cells(line)
            i += 2
            rows = []
            while i < n and "|" in lines[i] and lines[i].strip():
                rows.append(cells(lines[i]))
                i += 1
            out.append(
                '<div class="table-wrap"><table><thead><tr>'
                + "".join(f"<th>{_inline(c)}</th>" for c in head)
                + "</tr></thead><tbody>"
                + "".join("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in r) + "</tr>"
                          for r in rows)
                + "</tbody></table></div>")
            continue

        para.append(line)
        i += 1

    flush()
    return "".join(out)
