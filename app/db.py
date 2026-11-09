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
