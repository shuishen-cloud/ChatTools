"""画板：把分散在各会话的消息放到同一画布，并标注其间关系。

数据模型：
  board      画板
  board_node 消息引用 + 画布坐标 + 备注
  board_edge 节点间连线 + 关系标签

一个消息可被多个画板引用（多个 board_node 指向同一 message_id），
删除消息时 board_node 保留但 message_id 置空（显示为失效引用）。
"""
from __future__ import annotations

import json
from typing import Iterable

from .db import db, tx
from .utils import new_id, now, row_to_dict


def list_boards() -> list[dict]:
    with db() as conn:
        rows = [row_to_dict(r) for r in conn.execute(
            "SELECT * FROM board ORDER BY updated_at DESC")]
        for b in rows:
            b["node_count"] = conn.execute(
                "SELECT COUNT(*) c FROM board_node WHERE board_id=?", (b["id"],)).fetchone()["c"]
            b["edge_count"] = conn.execute(
                "SELECT COUNT(*) c FROM board_edge WHERE board_id=?", (b["id"],)).fetchone()["c"]
        return rows


def get_board(board_id: str) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM board WHERE id=?", (board_id,)).fetchone()
        if not row:
            return None
        board = row_to_dict(row)
        nodes = []
        for r in conn.execute(
                "SELECT * FROM board_node WHERE board_id=? ORDER BY created_at", (board_id,)):
            n = row_to_dict(r)
            # 联出消息内容，便于前端直接渲染
            if n["message_id"]:
                m = conn.execute(
                    "SELECT content, role, created_at FROM message WHERE id=?",
                    (n["message_id"],)).fetchone()
                if m:
                    n["content"] = m["content"]
                    n["role"] = m["role"]
                    n["missing"] = False
                else:
                    n["content"] = ""
                    n["missing"] = True
            else:
                n["content"] = ""
                n["missing"] = True
            # 会话标题，便于辨识来源
            if n["conv_id"]:
                c = conn.execute("SELECT title FROM conversation WHERE id=?",
                                 (n["conv_id"],)).fetchone()
                n["conv_title"] = c["title"] if c else ""
            else:
                n["conv_title"] = ""
            nodes.append(n)
        edges = [row_to_dict(r) for r in conn.execute(
            "SELECT * FROM board_edge WHERE board_id=?", (board_id,))]
        board["nodes"] = nodes
        board["edges"] = edges
        return board


def create_board(name: str = "未命名画板", description: str = "") -> dict:
    bid = new_id("b_")
    ts = now()
    with tx() as conn:
        conn.execute(
            "INSERT INTO board(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)",
            (bid, name, description, ts, ts))
    return get_board(bid)  # type: ignore[return-value]


def update_board(board_id: str, fields: dict) -> dict | None:
    allowed = {"name", "description"}
    sets, args = [], []
    for k, v in fields.items():
        if k in allowed:
            sets.append(f"{k}=?")
            args.append(v)
    with tx() as conn:
        if sets:
            sets.append("updated_at=?")
            args.append(now())
            args.append(board_id)
            conn.execute(f"UPDATE board SET {', '.join(sets)} WHERE id=?", args)
    return get_board(board_id)


def delete_board(board_id: str) -> None:
    with tx() as conn:
        conn.execute("DELETE FROM board WHERE id=?", (board_id,))


def _touch(conn, board_id: str) -> None:
    conn.execute("UPDATE board SET updated_at=? WHERE id=?", (now(), board_id))


def add_node(board_id: str, message_id: str | None, conv_id: str | None = None,
             x: float = 0, y: float = 0, note: str = "",
             color: str = "#6b8afd") -> dict:
    """把一条消息加入画板。同一消息在同一画板中不重复添加。"""
    with tx() as conn:
        if message_id:
            dup = conn.execute(
                "SELECT * FROM board_node WHERE board_id=? AND message_id=?",
                (board_id, message_id)).fetchone()
            if dup:
                return row_to_dict(dup)
            if not conv_id:
                m = conn.execute("SELECT conv_id FROM message WHERE id=?",
                                 (message_id,)).fetchone()
                conv_id = m["conv_id"] if m else None
        # 未指定坐标时自动排布：按列错开，避免重叠
        if x == 0 and y == 0:
            count = conn.execute("SELECT COUNT(*) c FROM board_node WHERE board_id=?",
                                 (board_id,)).fetchone()["c"]
            x = 40 + (count % 3) * 260
            y = 40 + (count // 3) * 180
        nid = new_id("n_")
        conn.execute(
            "INSERT INTO board_node(id,board_id,message_id,conv_id,x,y,note,color,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (nid, board_id, message_id, conv_id, x, y, note, color, now()))
        _touch(conn, board_id)
        row = conn.execute("SELECT * FROM board_node WHERE id=?", (nid,)).fetchone()
    return row_to_dict(row)


def update_node(node_id: str, fields: dict) -> dict | None:
    allowed = {"x", "y", "note", "color"}
    sets, args = [], []
    for k, v in fields.items():
        if k in allowed:
            sets.append(f"{k}=?")
            args.append(v)
    with tx() as conn:
        row = conn.execute("SELECT board_id FROM board_node WHERE id=?", (node_id,)).fetchone()
        if not row:
            return None
        if sets:
            args.append(node_id)
            conn.execute(f"UPDATE board_node SET {', '.join(sets)} WHERE id=?", args)
            _touch(conn, row["board_id"])
        out = conn.execute("SELECT * FROM board_node WHERE id=?", (node_id,)).fetchone()
    return row_to_dict(out)


def delete_node(node_id: str) -> None:
    with tx() as conn:
        row = conn.execute("SELECT board_id FROM board_node WHERE id=?", (node_id,)).fetchone()
        conn.execute("DELETE FROM board_node WHERE id=?", (node_id,))
        if row:
            _touch(conn, row["board_id"])


def add_edge(board_id: str, from_node: str, to_node: str,
             label: str = "", style: str = "solid") -> dict:
    if from_node == to_node:
        raise ValueError("不能连接到自己")
    eid = new_id("e_")
    with tx() as conn:
        # 同方向重复连线直接更新标签
        dup = conn.execute(
            "SELECT id FROM board_edge WHERE board_id=? AND from_node=? AND to_node=?",
            (board_id, from_node, to_node)).fetchone()
        if dup:
            conn.execute("UPDATE board_edge SET label=?, style=? WHERE id=?",
                         (label, style, dup["id"]))
            out = conn.execute("SELECT * FROM board_edge WHERE id=?", (dup["id"],)).fetchone()
        else:
            conn.execute(
                "INSERT INTO board_edge(id,board_id,from_node,to_node,label,style,created_at)"
                " VALUES(?,?,?,?,?,?,?)",
                (eid, board_id, from_node, to_node, label, style, now()))
            out = conn.execute("SELECT * FROM board_edge WHERE id=?", (eid,)).fetchone()
        _touch(conn, board_id)
    return row_to_dict(out)


def update_edge(edge_id: str, fields: dict) -> dict | None:
    allowed = {"label", "style"}
    sets, args = [], []
    for k, v in fields.items():
        if k in allowed:
            sets.append(f"{k}=?")
            args.append(v)
    with tx() as conn:
        if sets:
            args.append(edge_id)
            conn.execute(f"UPDATE board_edge SET {', '.join(sets)} WHERE id=?", args)
        row = conn.execute("SELECT * FROM board_edge WHERE id=?", (edge_id,)).fetchone()
    return row_to_dict(row) if row else None


def delete_edge(edge_id: str) -> None:
    with tx() as conn:
        conn.execute("DELETE FROM board_edge WHERE id=?", (edge_id,))


def boards_containing_message(message_id: str) -> list[str]:
    with db() as conn:
        return [r["board_id"] for r in conn.execute(
            "SELECT board_id FROM board_node WHERE message_id=?", (message_id,))]


# ---------------------------------------------------------------- 悬浮提问

def create_snippet(conv_id: str, message_id: str | None, source_text: str,
                   question: str) -> dict:
    sid = new_id("q_")
    with tx() as conn:
        conn.execute(
            "INSERT INTO snippet_qa(id,conv_id,message_id,source_text,question,created_at)"
            " VALUES(?,?,?,?,?,?)",
            (sid, conv_id, message_id, source_text, question, now()))
        row = conn.execute("SELECT * FROM snippet_qa WHERE id=?", (sid,)).fetchone()
    return row_to_dict(row)


def save_snippet_answer(snippet_id: str, answer: str, status: str = "done",
                        meta: dict | None = None) -> None:
    with tx() as conn:
        conn.execute(
            "UPDATE snippet_qa SET answer=?, status=?, meta=? WHERE id=?",
            (answer, status, json.dumps(meta or {}), snippet_id))


def list_snippets(conv_id: str) -> list[dict]:
    with db() as conn:
        return [row_to_dict(r) for r in conn.execute(
            "SELECT * FROM snippet_qa WHERE conv_id=? ORDER BY created_at DESC", (conv_id,))]


def delete_snippet(snippet_id: str) -> None:
    with tx() as conn:
        conn.execute("DELETE FROM snippet_qa WHERE id=?", (snippet_id,))
