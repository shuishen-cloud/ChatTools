"""通用工具：ID、时间、JSON 响应辅助。"""
from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from typing import Any

from starlette.responses import JSONResponse


def new_id(prefix: str = "") -> str:
    raw = secrets.token_hex(6)
    return f"{prefix}{raw}" if prefix else raw


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ok(data: Any = None, **extra) -> JSONResponse:
    body = {"ok": True, "data": data}
    body.update(extra)
    return JSONResponse(body)


def err(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"ok": False, "error": message}, status_code=status)


def row_to_dict(row) -> dict:
    return {k: row[k] for k in row.keys()}


async def read_json(request) -> dict:
    try:
        body = await request.body()
        return json.loads(body) if body else {}
    except json.JSONDecodeError:
        return {}


def parse_bool(value, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"1", "true", "yes", "on"}
