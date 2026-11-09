"""会话与消息树的核心逻辑。

消息以树形存储：message.parent_id 指向父消息。一个会话中的
"当前分支"就是最后被更新的那条路径；分支切换通过改变
conversation.head_id（保存在 setting 表里不合适，故用 message 的
favorite/meta 之外的方式）——这里采用更简单可靠的方案：
以 conversation 的 active_leaf 记录，惰性存储于 setting 表。
"""
from __future__ import annotations

import json
from typing import Iterable

from .db import db, tx
from .utils import new_id, now, row_to_dict


# ---------------------------------------------------------------- 会话

def list_conversations(folder_id: str | None = None,
                       q: str | None = None,
                       archived: bool = False) -> list[dict]:
    sql = """
        SELECT c.*,
               (SELECT COUNT(*) FROM message m WHERE m.conv_id = c.id) AS message_count,
               (SELECT m.content FROM message m WHERE m.conv_id = c.id
                 AND m.role='user' ORDER BY m.created_at ASC LIMIT 1) AS preview
        FROM conversation c
        WHERE c.archived = ?
    """
    args: list = [1 if archived else 0]
    if folder_id:
        sql += " AND EXISTS (SELECT 1 FROM conv_folder cf WHERE cf.conv_id=c.id AND cf.folder_id=?)"
        args.append(folder_id)
    if q:
        sql += """ AND (c.title LIKE ? OR EXISTS (
                     SELECT 1 FROM message m WHERE m.conv_id=c.id AND m.content LIKE ?))"""
        args += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY c.updated_at DESC"
    with db() as conn:
        rows = [row_to_dict(r) for r in conn.execute(sql, args)]
        for row in rows:
            row["folders"] = _folders_of(conn, row["id"])
            row["preview"] = (row["preview"] or "").strip().replace("\n", " ")[:120]
    return rows


def _folders_of(conn, conv_id: str) -> list[dict]:
    rows = conn.execute(
        """SELECT f.id, f.name, f.color FROM folder f
           JOIN conv_folder cf ON cf.folder_id=f.id WHERE cf.conv_id=?""", (conv_id,))
    return [row_to_dict(r) for r in rows]


def get_conversation(conv_id: str) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM conversation WHERE id=?", (conv_id,)).fetchone()
        if not row:
            return None
        conv = row_to_dict(row)
        conv["folders"] = _folders_of(conn, conv_id)
        return conv


def create_conversation(title: str = "未命名会话", model: str | None = None,
                        source: str = "local", folder_ids: Iterable[str] = (),
                        summary: str | None = None) -> dict:
    conv_id = new_id("c_")
    ts = now()
    with tx() as conn:
        conn.execute(
            "INSERT INTO conversation(id,title,model,source,summary,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (conv_id, title, model, source, summary, ts, ts))
        for fid in folder_ids:
            conn.execute("INSERT OR IGNORE INTO conv_folder(conv_id,folder_id) VALUES(?,?)",
                         (conv_id, fid))
    return get_conversation(conv_id)  # type: ignore[return-value]


def update_conversation(conv_id: str, fields: dict) -> dict | None:
    allowed = {"title", "model", "source", "summary", "archived"}
    sets, args = [], []
    for key, value in fields.items():
        if key in allowed:
            sets.append(f"{key}=?")
            args.append(int(value) if key == "archived" else value)
    with tx() as conn:
        if sets:
            sets.append("updated_at=?")
            args.append(now())
            args.append(conv_id)
            conn.execute(f"UPDATE conversation SET {', '.join(sets)} WHERE id=?", args)
    return get_conversation(conv_id)


def delete_conversation(conv_id: str) -> None:
    with tx() as conn:
        conn.execute("DELETE FROM conversation WHERE id=?", (conv_id,))


def touch(conn, conv_id: str) -> None:
    conn.execute("UPDATE conversation SET updated_at=? WHERE id=?", (now(), conv_id))


# ---------------------------------------------------------------- 消息 / 分支

def get_messages(conv_id: str, flat: bool = False) -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM message WHERE conv_id=? ORDER BY created_at ASC", (conv_id,)).fetchall()
        msgs = []
        for r in rows:
            m = row_to_dict(r)
            m["meta"] = json.loads(m["meta"] or "{}")
            m["favorite"] = bool(m["favorite"])
            m["tags"] = [t for t in m["tags"].split(",") if t]
            m["child_count"] = 0
            msgs.append(m)
    for m in msgs:
        m["child_count"] = sum(1 for x in msgs if x["parent_id"] == m["id"])
    return msgs


def add_message(conv_id: str, role: str, content: str,
                parent_id: str | None = None, meta: dict | None = None) -> dict:
    """parent_id 为空时自动挂到当前分支末端（用于追加对话）。"""
    msg_id = new_id("m_")
    ts = now()
    with tx() as conn:
        if parent_id is None:
            row = conn.execute(
                "SELECT id FROM message WHERE conv_id=? ORDER BY created_at DESC LIMIT 1",
                (conv_id,)).fetchone()
            parent_id = row["id"] if row else None
        conn.execute(
            "INSERT INTO message(id,conv_id,parent_id,role,content,meta,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (msg_id, conv_id, parent_id, role, content, json.dumps(meta or {}), ts))
        touch(conn, conv_id)
    with db() as conn:
        return row_to_dict(conn.execute("SELECT * FROM message WHERE id=?", (msg_id,)).fetchone())


def update_message(msg_id: str, fields: dict) -> dict | None:
    sets, args = [], []
    for key in ("content", "favorite", "tags"):
        if key in fields:
            value = fields[key]
            if key == "favorite":
                value = 1 if value else 0
            elif key == "tags" and isinstance(value, list):
                value = ",".join(value)
            sets.append(f"{key}=?")
            args.append(value)
    if fields.get("meta") is not None:
        sets.append("meta=?")
        args.append(json.dumps(fields["meta"]))
    with tx() as conn:
        if sets:
            args.append(msg_id)
            conn.execute(f"UPDATE message SET {', '.join(sets)} WHERE id=?", args)
        row = conn.execute("SELECT * FROM message WHERE id=?", (msg_id,)).fetchone()
    return row_to_dict(row) if row else None


def delete_message(msg_id: str, cascade: bool = True) -> None:
    """删除消息；cascade=True 时连同其整棵子树一起删除。"""
    with tx() as conn:
        if cascade:
            ids, frontier = {msg_id}, [msg_id]
            while frontier:
                nxt = []
                for mid in frontier:
                    for r in conn.execute("SELECT id FROM message WHERE parent_id=?", (mid,)):
                        if r["id"] not in ids:
                            ids.add(r["id"])
                            nxt.append(r["id"])
                frontier = nxt
            conn.executemany("DELETE FROM message WHERE id=?", [(i,) for i in ids])
        else:
            # 子节点上提到被删节点的父节点，保持树不断裂
            parent = conn.execute("SELECT parent_id FROM message WHERE id=?", (msg_id,)).fetchone()
            pid = parent["parent_id"] if parent else None
            conn.execute("UPDATE message SET parent_id=? WHERE parent_id=?", (pid, msg_id))
            conn.execute("DELETE FROM message WHERE id=?", (msg_id,))


def path_to_root(conn, msg_id: str) -> list[str]:
    """自根到指定消息的祖先链。"""
    chain, cur, guard = [], msg_id, 0
    while cur and guard < 10000:
        chain.append(cur)
        row = conn.execute("SELECT parent_id FROM message WHERE id=?", (cur,)).fetchone()
        if not row:
            break
        cur = row["parent_id"]
        guard += 1
    return list(reversed(chain))


def branch_of(msg_id: str) -> list[str]:
    """给定任意消息，返回从根到该消息所在叶子节点的完整主路径。"""
    with db() as conn:
        chain = path_to_root(conn, msg_id)
        cur = msg_id
        while True:
            kids = conn.execute(
                "SELECT id FROM message WHERE parent_id=? ORDER BY created_at ASC LIMIT 1",
                (cur,)).fetchall()
            if not kids:
                break
            cur = kids[0]["id"]
            chain.append(cur)
        return chain


def edit_message_as_branch(msg_id: str, content: str) -> dict:
    """编辑已有消息 => 在父节点下新建兄弟分支（不破坏原有历史）。

    返回新消息 + 其父节点 id，前端据此跳转到新分支。
    """
    with tx() as conn:
        row = conn.execute("SELECT * FROM message WHERE id=?", (msg_id,)).fetchone()
        if not row:
            raise KeyError("message not found")
        new_mid = new_id("m_")
        conn.execute(
            "INSERT INTO message(id,conv_id,parent_id,role,content,meta,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (new_mid, row["conv_id"], row["parent_id"], row["role"], content,
             row["meta"], now()))
        touch(conn, row["conv_id"])
        out = row_to_dict(conn.execute("SELECT * FROM message WHERE id=?", (new_mid,)).fetchone())
    out["parent_id_original"] = row["parent_id"]
    return out


def siblings(msg_id: str) -> dict:
    """返回消息在兄弟分支中的位置，供 UI 显示 1/3 分支切换器。"""
    with db() as conn:
        row = conn.execute("SELECT conv_id,parent_id FROM message WHERE id=?", (msg_id,)).fetchone()
        if not row:
            return {"index": 0, "total": 0, "items": []}
        if row["parent_id"] is None:
            rows = conn.execute(
                "SELECT id FROM message WHERE conv_id=? AND parent_id IS NULL"
                " ORDER BY created_at ASC", (row["conv_id"],)).fetchall()
        else:
            rows = conn.execute(
                "SELECT id FROM message WHERE parent_id=? ORDER BY created_at ASC",
                (row["parent_id"],)).fetchall()
        ids = [r["id"] for r in rows]
        idx = ids.index(msg_id) if msg_id in ids else -1
        return {"index": idx + 1, "total": len(ids), "items": ids}


def main_branch(msgs: list[dict]) -> list[str]:
    """返回最新叶子的主路径 id 列表（用于默认渲染的对话线）。"""
    if not msgs:
        return []
    by_id = {m["id"]: m for m in msgs}
    leaves = [m for m in msgs if not any(x["parent_id"] == m["id"] for x in msgs)]
    leaves.sort(key=lambda m: m["created_at"], reverse=True)
    cur = leaves[0]["id"] if leaves else msgs[-1]["id"]
    chain: list[str] = []
    while cur:
        chain.append(cur)
        cur = by_id[cur]["parent_id"] if by_id.get(cur) else None
    return list(reversed(chain))


def list_favorites(q: str | None = None, tag: str | None = None) -> list[dict]:
    sql = """SELECT m.*, c.title AS conv_title FROM message m
             JOIN conversation c ON c.id=m.conv_id
             WHERE m.favorite=1"""
    args: list = []
    if q:
        sql += " AND m.content LIKE ?"
        args.append(f"%{q}%")
    if tag:
        sql += " AND (',' || m.tags || ',') LIKE ?"
        args.append(f"%,{tag},%")
    sql += " ORDER BY m.created_at DESC"
    with db() as conn:
        out = []
        for r in conn.execute(sql, args):
            d = row_to_dict(r)
            d["meta"] = json.loads(d["meta"] or "{}")
            d["tags"] = [t for t in d["tags"].split(",") if t]
            out.append(d)
        return out


def set_favorite(msg_id: str, favorite: bool) -> None:
    with tx() as conn:
        conn.execute("UPDATE message SET favorite=? WHERE id=?", (1 if favorite else 0, msg_id))
