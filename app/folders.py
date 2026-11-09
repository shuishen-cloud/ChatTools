"""文件夹（多对多归类）与标签管理。"""
from __future__ import annotations

from .db import db, tx
from .utils import new_id, now, row_to_dict


def list_folders(with_stats: bool = True) -> list[dict]:
    with db() as conn:
        rows = [row_to_dict(r) for r in
                conn.execute("SELECT * FROM folder ORDER BY sort_key ASC, name ASC")]
        if with_stats:
            for f in rows:
                f["count"] = conn.execute(
                    "SELECT COUNT(*) c FROM conv_folder cf JOIN conversation c ON c.id=cf.conv_id"
                    " WHERE cf.folder_id=? AND c.archived=0", (f["id"],)).fetchone()["c"]
                f["total"] = conn.execute(
                    "SELECT COUNT(*) c FROM conv_folder cf WHERE cf.folder_id=?",
                    (f["id"],)).fetchone()["c"]
        return rows


def create_folder(name: str, color: str = "#6b8afd", description: str = "",
                  parent_id: str | None = None) -> dict:
    fid = new_id("f_")
    with tx() as conn:
        sort_key = conn.execute("SELECT COALESCE(MAX(sort_key),0)+1 s FROM folder").fetchone()["s"]
        conn.execute(
            "INSERT INTO folder(id,name,color,description,parent_id,sort_key,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (fid, name, color, description, parent_id, sort_key, now()))
        row = conn.execute("SELECT * FROM folder WHERE id=?", (fid,)).fetchone()
    return row_to_dict(row)


def update_folder(folder_id: str, fields: dict) -> dict | None:
    allowed = {"name", "color", "description", "parent_id", "sort_key"}
    sets, args = [], []
    for key, value in fields.items():
        if key in allowed:
            sets.append(f"{key}=?")
            args.append(value)
    with tx() as conn:
        if sets:
            args.append(folder_id)
            conn.execute(f"UPDATE folder SET {', '.join(sets)} WHERE id=?", args)
        row = conn.execute("SELECT * FROM folder WHERE id=?", (folder_id,)).fetchone()
    return row_to_dict(row) if row else None


def delete_folder(folder_id: str) -> None:
    with tx() as conn:
        conn.execute("DELETE FROM folder WHERE id=?", (folder_id,))


def link(conv_id: str, folder_id: str) -> None:
    with tx() as conn:
        conn.execute("INSERT OR IGNORE INTO conv_folder(conv_id,folder_id) VALUES(?,?)",
                     (conv_id, folder_id))


def unlink(conv_id: str, folder_id: str) -> None:
    with tx() as conn:
        conn.execute("DELETE FROM conv_folder WHERE conv_id=? AND folder_id=?",
                     (conv_id, folder_id))


def set_conv_folders(conv_id: str, folder_ids: list[str]) -> list[str]:
    with tx() as conn:
        conn.execute("DELETE FROM conv_folder WHERE conv_id=?", (conv_id,))
        for fid in folder_ids:
            conn.execute("INSERT OR IGNORE INTO conv_folder(conv_id,folder_id) VALUES(?,?)",
                         (conv_id, fid))
        return [r["folder_id"] for r in
                conn.execute("SELECT folder_id FROM conv_folder WHERE conv_id=?", (conv_id,))]


def folder_tree() -> list[dict]:
    """把扁平文件夹组织成树，便于前端渲染脉络。"""
    flat = list_folders()
    by_id = {f["id"]: {**f, "children": []} for f in flat}
    roots: list[dict] = []
    for f in by_id.values():
        parent = by_id.get(f["parent_id"]) if f["parent_id"] else None
        (parent["children"] if parent else roots).append(f)
    return roots


# ---------------------------------------------------------------- 标签

def list_tags() -> list[dict]:
    with db() as conn:
        rows = [row_to_dict(r) for r in conn.execute("SELECT * FROM tag ORDER BY name")]
        for t in rows:
            t["count"] = conn.execute(
                "SELECT COUNT(*) c FROM message_tag WHERE tag_id=?", (t["id"],)).fetchone()["c"]
        return rows


def add_tag(msg_id: str, name: str, color: str = "#8b95a7") -> dict:
    with tx() as conn:
        row = conn.execute("SELECT * FROM tag WHERE name=?", (name,)).fetchone()
        if row:
            tid = row["id"]
        else:
            tid = new_id("t_")
            conn.execute("INSERT INTO tag(id,name,color) VALUES(?,?,?)", (tid, name, color))
        conn.execute("INSERT OR IGNORE INTO message_tag(message_id,tag_id) VALUES(?,?)",
                     (msg_id, tid))
        mrow = conn.execute("SELECT tags FROM message WHERE id=?", (msg_id,)).fetchone()
        if mrow is not None:
            tags = {t for t in (mrow["tags"] or "").split(",") if t}
            tags.add(name)
            conn.execute("UPDATE message SET tags=? WHERE id=?", (",".join(sorted(tags)), msg_id))
    return {"id": tid, "name": name, "color": color}


def remove_tag(msg_id: str, name: str) -> None:
    with tx() as conn:
        row = conn.execute("SELECT id FROM tag WHERE name=?", (name,)).fetchone()
        if row:
            conn.execute("DELETE FROM message_tag WHERE message_id=? AND tag_id=?",
                         (msg_id, row["id"]))
        mrow = conn.execute("SELECT tags FROM message WHERE id=?", (msg_id,)).fetchone()
        if mrow is not None:
            tags = {t for t in (mrow["tags"] or "").split(",") if t and t != name}
            conn.execute("UPDATE message SET tags=? WHERE id=?", (",".join(sorted(tags)), msg_id))
