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
            own = n.get("content") or ""
            # 失效判定：没有可用内容即视为失效（引用消息被删且无自有文本）
            n["missing"] = False
            if n["message_id"]:
                # 引用消息：内容以消息为准
                m = conn.execute(
                    "SELECT content, role, created_at FROM message WHERE id=?",
                    (n["message_id"],)).fetchone()
                if m:
                    n["content"] = m["content"]
                    n["role"] = m["role"]
                    n["missing"] = False
                else:
                    # 引用过消息但现在取不到 -> 失效引用
                    n["content"] = own
                    n["role"] = n.get("role") or "note"
                    n["missing"] = not own
            else:
                # 无 message_id：自由文本节点，或「引用消息已被删除」
                n["content"] = own
                n["role"] = "note"
                n["missing"] = not own
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
             color: str = "#6b8afd", content: str = "") -> dict:
    """把一条消息加入画板。同一消息在同一画板中不重复添加。

    message_id 可为 None：此时用 content 作为节点自有文字，
    用于把悬浮问答或自由笔记直接放到画板上，不依赖任何会话。
    """
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
            "INSERT INTO board_node(id,board_id,message_id,conv_id,content,x,y,note,color,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (nid, board_id, message_id, conv_id, content, x, y, note, color, now()))
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

def create_snippet(conv_id: str | None, message_id: str | None, source_text: str,
                   question: str) -> dict:
    """conv_id 可为 None：悬浮提问不依赖会话。"""
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


# ---------------------------------------------------------------- 分享到 draw
# 与 draw 项目（上层 ../draw）的 exportCanvasData 格式保持一致：
#   { format:'mutiplechat-canvas', version:1, view, nodes[], edges[], zones[], tasks[] }
# 这样 draw 的「⬆ 导入」可以直接吃下这个 JSON。
# 额外携带 draw_cards 元信息（来源、标签、收藏时间），draw 侧收藏时使用。

DRAW_COLS = 3          # 卡片自动排布：每行几列
CARD_W, CARD_H = 300, 160
CARD_GAP_X, CARD_GAP_Y = 60, 60
ORIGIN_X, ORIGIN_Y = 160, 160


def _card_text(msg: dict) -> str:
    """卡片正文：干净的 Markdown，带来源信息。"""
    content = (msg.get("content") or "").strip()
    tags = msg.get("tags") or []
    head = []
    if msg.get("role"):
        head.append(f"> 角色：{msg['role']}")
    if msg.get("conv_title"):
        head.append(f"> 来源：《{msg['conv_title']}》")
    if tags:
        head.append(f"> 标签：{'、'.join(tags)}")
    if msg.get("created_at"):
        head.append(f"> 收藏自 ChatTool · {msg['created_at']}")
    return "\n".join(head + ([""] if head else []) + [content])


def favorites_to_draw(names: list[str] | None = None) -> dict:
    """把收藏的消息打包成 draw 画布数据。

    names: 可选，仅导出这些 message_id；为空则导出全部收藏。
    """
    favs = _list_favorites_raw()
    if names:
        wanted = set(names)
        favs = [m for m in favs if m["id"] in wanted]
    nodes = []
    draw_cards = []
    for idx, m in enumerate(favs):
        nid = f"n{idx + 1}"
        title = (m.get("conv_title") or "收藏").strip()
        snippet = (m.get("content") or "").strip().replace("\n", " ")
        if snippet:
            title = f"{title} · {snippet[:18]}{'…' if len(snippet) > 18 else ''}"
        x = ORIGIN_X + (idx % DRAW_COLS) * (CARD_W + CARD_GAP_X)
        y = ORIGIN_Y + (idx // DRAW_COLS) * (CARD_H + CARD_GAP_Y)
        nodes.append({
            "id": nid, "kind": "doc", "title": title,
            "x": x, "y": y, "w": CARD_W, "h": CARD_H,
            "text": _card_text(m), "src": "", "prompt": "",
            "zoneId": None, "level": 1,
        })
        draw_cards.append({
            "nodeId": nid,
            "messageId": m["id"],
            "convId": m.get("conv_id"),
            "convTitle": m.get("conv_title") or "",
            "role": m.get("role") or "",
            "tags": m.get("tags") or [],
            "favoriteAt": m.get("created_at") or "",
            "source": "chattool",
        })
    return {
        "format": "mutiplechat-canvas",
        "version": 1,
        "generator": "ChatTool",
        "view": {"x": 0, "y": 0, "scale": 1},
        "nodes": nodes,
        "edges": [],
        "zones": [],
        "tasks": [],
        "draw_cards": draw_cards,
    }


def _list_favorites_raw() -> list[dict]:
    """收藏消息（含会话标题与技术字段），供分享使用。"""
    with db() as conn:
        out = []
        for r in conn.execute(
                "SELECT m.*, c.title AS conv_title FROM message m "
                "JOIN conversation c ON c.id=m.conv_id "
                "WHERE m.favorite=1 ORDER BY m.created_at DESC"):
            d = row_to_dict(r)
            d["tags"] = [t for t in (d.get("tags") or "").split(",") if t]
            out.append(d)
        return out
