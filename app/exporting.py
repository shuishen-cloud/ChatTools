"""导出 / 导入 / 分享。

支持格式：
  md      Markdown（含分支结构说明）
  json    ChatTool 原生格式（可回流导入）
  html    独立分享页（内联样式，单文件，可直接发给别人）
  txt     纯文本
"""
from __future__ import annotations

import html
import json
import secrets
from datetime import datetime
from urllib.parse import quote

from . import markdown as md
from .conversations import get_conversation, get_messages
from .db import db, tx
from .utils import new_id, now

SHARE_PREFIX = "share:"


def content_disposition(fname: str) -> str:
    """RFC 5987：中文文件名必须 URL 编码，同时保留 ASCII 回退名。"""
    ascii_name = fname.encode("ascii", "replace").decode().replace("?", "_")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(fname)}"


def build_export(conv_id: str, fmt: str = "md", branch_only: bool = False) -> tuple[str, str, str]:
    """返回 (内容, MIME, 文件名)。"""
    conv = get_conversation(conv_id)
    if not conv:
        raise KeyError("conversation not found")
    msgs = get_messages(conv_id)

    if branch_only:
        keep = set(_main_branch(msgs))
        msgs = [m for m in msgs if m["id"] in keep]

    if fmt == "json":
        payload = {
            "tool": "chattool",
            "version": 1,
            "exported_at": now(),
            "conversation": {k: conv[k] for k in
                             ("id", "title", "model", "source", "summary", "created_at", "updated_at")},
            "folders": conv.get("folders", []),
            "messages": [{k: m[k] for k in
                          ("id", "parent_id", "role", "content", "favorite", "tags", "created_at")}
                         for m in msgs],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2), "application/json", _fname(conv, "json")
    if fmt == "html":
        return _to_html(conv, msgs), "text/html; charset=utf-8", _fname(conv, "html")
    if fmt == "txt":
        return _to_txt(conv, msgs), "text/plain; charset=utf-8", _fname(conv, "txt")
    return _to_md(conv, msgs), "text/markdown; charset=utf-8", _fname(conv, "md")


def _fname(conv: dict, ext: str) -> str:
    safe = "".join(ch for ch in conv["title"] if ch not in '\\/:*?"<>|').strip() or "conversation"
    return f"{safe[:40]}.{ext}"


def _main_branch(msgs: list[dict]) -> list[str]:
    if not msgs:
        return []
    by_id = {m["id"]: m for m in msgs}
    leaves = [m for m in msgs if not any(x["parent_id"] == m["id"] for x in msgs)]
    leaves.sort(key=lambda m: m["created_at"], reverse=True)
    out, cur = [], leaves[0]["id"] if leaves else msgs[-1]["id"]
    while cur:
        out.append(cur)
        cur = by_id[cur]["parent_id"] if by_id.get(cur) else None
    return list(reversed(out))


ROLE_LABEL = {"user": "👤 用户", "assistant": "🤖 助手", "system": "⚙️ 系统", "tool": "🔧 工具"}


def _to_md(conv: dict, msgs: list[dict]) -> str:
    lines = [f"# {conv['title']}", ""]
    meta = [f"- 创建：{conv['created_at']}", f"- 更新：{conv['updated_at']}"]
    if conv.get("model"):
        meta.append(f"- 模型：{conv['model']}")
    if conv.get("folders"):
        meta.append("- 文件夹：" + "、".join(f["name"] for f in conv["folders"]))
    lines += meta + ["", "---", ""]
    for m in msgs:
        star = " ⭐" if m.get("favorite") else ""
        tags = ("  `" + "` `".join(m["tags"]) + "`") if m.get("tags") else ""
        lines.append(f"### {ROLE_LABEL.get(m['role'], m['role'])}{star}{tags}")
        lines.append("")
        lines.append(m["content"].strip())
        lines.append("")
        if m.get("child_count", 0) > 1:
            lines.append(f"> 🔀 此处有 {m['child_count']} 个分支")
            lines.append("")
    return "\n".join(lines)


def _to_txt(conv: dict, msgs: list[dict]) -> str:
    lines = [conv["title"], "=" * len(conv["title"]), ""]
    for m in msgs:
        lines += [f"[{m['created_at']}] {ROLE_LABEL.get(m['role'], m['role'])}:", m["content"], ""]
    return "\n".join(lines)


HTML_TPL = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>
:root{{--bg:#0f1117;--card:#171a23;--line:#262a36;--fg:#e6e8ef;--dim:#8b95a7;--acc:#6b8afd}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--fg);
font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}}
.wrap{{max-width:820px;margin:0 auto;padding:24px 16px 80px}}
h1{{font-size:1.5rem;margin:0 0 8px}}.meta{{color:var(--dim);font-size:.85rem;margin-bottom:24px}}
.m{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:14px 0}}
.role{{font-size:.8rem;color:var(--dim);margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}}
.m.user{{border-left:3px solid var(--acc)}}.m.assistant{{border-left:3px solid #37c98b}}
.m.system{{border-left:3px solid #8b95a7}}.m.tool{{border-left:3px solid #d9a23b}}
.fav{{color:#e8c15a}}.tag{{background:#232838;color:#9aa6bf;border-radius:999px;padding:1px 8px;font-size:.72rem}}
.content{{word-break:break-word}}
.content code{{background:#0b0d12;padding:1px 5px;border-radius:4px;font-size:.9em}}
.md p{{margin:0 0 .6em}}.md p:last-child{{margin-bottom:0}}
.md .md-h{{margin:.8em 0 .4em;line-height:1.35;font-size:1.1em}}
.md ul,.md ol{{margin:.3em 0 .6em;padding-left:1.35em}}
.md blockquote{{margin:.5em 0;padding:.35em .8em;border-left:3px solid #39415a;
  background:#10131b;border-radius:0 8px 8px 0;color:#b9c2d6}}
.md hr{{border:none;border-top:1px solid #262a36;margin:.9em 0}}
.md a{{color:#6b8afd;text-decoration:none}}.md a:hover{{text-decoration:underline}}
.code-wrap{{margin:.5em 0}}.code-wrap pre{{margin:0;background:#0b0d12;border:1px solid #262a36;
  border-radius:8px;padding:10px;overflow-x:auto;font-size:12.5px}}
.code-lang{{font-size:10.5px;color:#8b95a7;padding:0 2px 3px}}
.table-wrap{{overflow-x:auto;margin:.5em 0}}
.md table{{border-collapse:collapse;width:100%;font-size:.93em}}
.md th,.md td{{border:1px solid #262a36;padding:6px 10px;text-align:left}}
.md th{{background:#1b1f2a}}
.md .tasklist{{list-style:none;padding-left:.2em}}
.md .tasklist li{{display:flex;gap:7px;align-items:flex-start}}
.md .tasklist .box{{flex:0 0 auto;width:14px;height:14px;margin-top:.25em;
  border:1.5px solid #4a5468;border-radius:4px;font-size:10px;line-height:12px;
  text-align:center;color:#37c98b}}
.md .tasklist li.done .box{{border-color:#37c98b;background:#133527}}
.md .tasklist li.done{{color:#8b95a7}}
.md .md-img{{max-width:100%;border-radius:8px;display:block;margin:.5em 0}}
.branch{{color:var(--dim);font-size:.78rem;margin-top:8px;border-top:1px dashed var(--line);padding-top:6px}}
footer{{color:var(--dim);font-size:.78rem;text-align:center;margin-top:40px}}
</style></head><body><div class="wrap">
<h1>{title}</h1><div class="meta">{meta}</div>{body}
<footer>由 ChatTool 导出 · {ts}</footer></div></body></html>"""


def _to_html(conv: dict, msgs: list[dict]) -> str:
    parts = []
    for m in msgs:
        badges = []
        if m.get("favorite"):
            badges.append('<span class="fav">⭐ 收藏</span>')
        badges += [f'<span class="tag">{html.escape(t)}</span>' for t in m.get("tags", [])]
        content = md.render(m["content"])
        branch = (f'<div class="branch">🔀 此消息有 {m["child_count"]} 个分支</div>'
                  if m.get("child_count", 0) > 1 else "")
        parts.append(
            f'<div class="m {m["role"]}"><div class="role">'
            f'<span>{ROLE_LABEL.get(m["role"], m["role"])}</span>'
            f'<span style="opacity:.6">{m["created_at"]}</span>{"".join(badges)}</div>'
            f'<div class="content md">{content}</div>{branch}</div>')
    meta_bits = [f"更新于 {conv['updated_at']}"]
    if conv.get("model"):
        meta_bits.append(html.escape(conv["model"]))
    if conv.get("folders"):
        meta_bits.append("文件夹：" + "、".join(html.escape(f["name"]) for f in conv["folders"]))
    return HTML_TPL.format(title=html.escape(conv["title"]), meta=" · ".join(meta_bits),
                           body="\n".join(parts), ts=datetime.now().strftime("%Y-%m-%d %H:%M"))


# ---------------------------------------------------------------- 分享

def create_share(conv_id: str, branch_only: bool = False) -> dict:
    if not get_conversation(conv_id):
        raise KeyError("conversation not found")
    token = secrets.token_urlsafe(12)
    with tx() as conn:
        conn.execute("INSERT INTO setting(key,value) VALUES(?,?)",
                     (f"share:{token}", json.dumps({"conv_id": conv_id, "branch_only": branch_only,
                                                    "at": now()})))
    return {"token": token, "url": f"/s/{token}", "html_url": f"/s/{token}.html"}


def resolve_share(token: str) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT value FROM setting WHERE key=?", (f"share:{token}",)).fetchone()
    return json.loads(row["value"]) if row else None


def revoke_share(token: str) -> None:
    with tx() as conn:
        conn.execute("DELETE FROM setting WHERE key=?", (f"share:{token}",))


# ---------------------------------------------------------------- 导入

def import_payload(payload: dict, folder_ids: list[str] | None = None,
                   source: str = "import") -> dict:
    """导入 ChatTool JSON，或宽松解析其他格式（messages 列表）。"""
    conv_raw = payload.get("conversation") or {}
    msgs = payload.get("messages") or []
    title = conv_raw.get("title") or payload.get("title") or "导入的会话"
    conv_id = new_id("c_")
    ts = now()
    with tx() as conn:
        conn.execute(
            "INSERT INTO conversation(id,title,model,source,summary,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (conv_id, title, conv_raw.get("model"), source, conv_raw.get("summary"),
             conv_raw.get("created_at") or ts, ts))
        # 保留原 id 映射，兼容旧 id 与 parent 引用
        idmap: dict[str, str] = {}
        for idx, m in enumerate(msgs):
            # 无 id 时用下标合成稳定的键，保证两轮循环能对上
            idmap[str(m.get("id") or f"__idx{idx}")] = new_id("m_")
        for idx, m in enumerate(msgs):
            key = str(m.get("id") or f"__idx{idx}")
            pid_old = m.get("parent_id") or m.get("parentId")
            prev = idx - 1 if idx > 0 else None
            # 缺省时按时间顺序线性串接，保持对话可读
            parent = idmap.get(str(pid_old)) if pid_old else (idmap.get(str(msgs[prev].get("id") or f"__idx{prev}")) if prev is not None else None)
            tags = m.get("tags") or []
            conn.execute(
                "INSERT INTO message(id,conv_id,parent_id,role,content,favorite,tags,meta,created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (idmap[key], conv_id, parent,
                 m.get("role", "user"), m.get("content", ""),
                 1 if m.get("favorite") else 0,
                 ",".join(tags) if isinstance(tags, list) else str(tags),
                 json.dumps(m.get("meta") or {}), m.get("created_at") or ts))
        for fid in (folder_ids or []):
            conn.execute("INSERT OR IGNORE INTO conv_folder(conv_id,folder_id) VALUES(?,?)",
                         (conv_id, fid))
        conv = conn.execute("SELECT * FROM conversation WHERE id=?", (conv_id,)).fetchone()
        count = conn.execute("SELECT COUNT(*) c FROM message WHERE conv_id=?",
                             (conv_id,)).fetchone()["c"]
    return {"conversation": dict(conv), "message_count": count}


def import_pi_session(raw: dict | str) -> dict:
    """解析 Pi（pi-coding-agent）的会话导出结构。

    Pi 的 session 通常是 {id, title, messages:[{role, content, ...}]}，
    content 可能是字符串或 [{type:'text',text:'...'}] 块数组。
    """
    if isinstance(raw, str):
        raw = json.loads(raw)
    title = raw.get("title") or raw.get("name") or "Pi 会话"
    msgs_in = raw.get("messages") or raw.get("entries") or []
    msgs = []
    for item in msgs_in:
        if not isinstance(item, dict):
            continue
        role = item.get("role") or item.get("type") or "user"
        if role not in {"user", "assistant", "system", "tool"}:
            continue
        content = item.get("content")
        if isinstance(content, list):
            pieces = []
            for blk in content:
                if isinstance(blk, dict):
                    if blk.get("type") == "text":
                        pieces.append(blk.get("text", ""))
                    elif blk.get("type") == "tool_use":
                        pieces.append(f"[tool_use {blk.get('name','')}]")
                elif isinstance(blk, str):
                    pieces.append(blk)
            content = "\n".join(pieces)
        msgs.append({"id": item.get("id"), "role": role, "content": content or "",
                     "parent_id": item.get("parentId") or item.get("parent_id"),
                     "created_at": item.get("timestamp") or item.get("created_at")})
    return import_payload({"conversation": {"title": title, "model": raw.get("model")},
                           "messages": msgs}, source="pi")
