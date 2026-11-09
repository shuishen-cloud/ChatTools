"""SQLite 存储层：负责建表、连接管理与轻量迁移。"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

DATA_DIR = Path(os.environ.get("CHATTOOL_DATA", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = Path(os.environ.get("CHATTOOL_DB", DATA_DIR / "chattool.db"))

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversation (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '未命名会话',
    model       TEXT,
    source      TEXT NOT NULL DEFAULT 'local',   -- 来源：local / pi / chatgpt ...
    summary     TEXT,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
    id          TEXT PRIMARY KEY,
    conv_id     TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES message(id) ON DELETE SET NULL,
    role        TEXT NOT NULL,                    -- user / assistant / system / tool
    content     TEXT NOT NULL DEFAULT '',
    favorite    INTEGER NOT NULL DEFAULT 0,
    tags        TEXT NOT NULL DEFAULT '',         -- 逗号分隔
    meta        TEXT NOT NULL DEFAULT '{}',       -- JSON：token 数、模型等
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_conv ON message(conv_id);
CREATE INDEX IF NOT EXISTS idx_message_parent ON message(parent_id);

CREATE TABLE IF NOT EXISTS folder (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#6b8afd',
    description TEXT NOT NULL DEFAULT '',
    parent_id   TEXT REFERENCES folder(id) ON DELETE SET NULL,
    sort_key    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conv_folder (
    conv_id     TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    folder_id   TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
    PRIMARY KEY (conv_id, folder_id)
);
CREATE INDEX IF NOT EXISTS idx_cf_folder ON conv_folder(folder_id);

-- 每条消息可打任意标签，便于跨会话横向观察脉络
CREATE TABLE IF NOT EXISTS tag (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    color       TEXT NOT NULL DEFAULT '#8b95a7'
);

CREATE TABLE IF NOT EXISTS message_tag (
    message_id  TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    tag_id      TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, tag_id)
);

CREATE TABLE IF NOT EXISTS setting (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);

-- 画板：把分散在各会话的消息放到同一画布上组织关系
CREATE TABLE IF NOT EXISTS board (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '未命名画板',
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- 画板节点：引用一条消息（可能来自不同会话），带画布坐标与备注
CREATE TABLE IF NOT EXISTS board_node (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES board(id) ON DELETE CASCADE,
    message_id  TEXT REFERENCES message(id) ON DELETE SET NULL,
    conv_id     TEXT REFERENCES conversation(id) ON DELETE SET NULL,
    x           REAL NOT NULL DEFAULT 0,
    y           REAL NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#6b8afd',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bnode_board ON board_node(board_id);

-- 画板连线：节点间的关系，label 描述关系语义
CREATE TABLE IF NOT EXISTS board_edge (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES board(id) ON DELETE CASCADE,
    from_node   TEXT NOT NULL REFERENCES board_node(id) ON DELETE CASCADE,
    to_node     TEXT NOT NULL REFERENCES board_node(id) ON DELETE CASCADE,
    label       TEXT NOT NULL DEFAULT '',
    style       TEXT NOT NULL DEFAULT 'solid',   -- solid / dashed
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bedge_board ON board_edge(board_id);

-- 悬浮提问：针对某段选中内容的独立问答，不污染主对话
CREATE TABLE IF NOT EXISTS snippet_qa (
    id          TEXT PRIMARY KEY,
    conv_id     TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    message_id  TEXT REFERENCES message(id) ON DELETE SET NULL,
    source_text TEXT NOT NULL,
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    meta        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sqa_conv ON snippet_qa(conv_id);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """写事务：BEGIN IMMEDIATE 避免并发写冲突。"""
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
