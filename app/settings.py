"""LLM 供应商配置：API Key 的存储与读取。

安全原则：
1. Key 只存在服务端（SQLite setting 表），**永不返回给前端**；
2. 前端只能看到「是否已配置 + 掩码尾号 + 来源」；
3. 环境变量优先级高于数据库，避免误覆盖部署环境；
4. 记录来源，便于审计（env / ui）。
"""
from __future__ import annotations

import json
import os

from .db import db, tx
from .utils import now

PROVIDERS = {
    "anthropic": {
        "label": "Anthropic (Claude)",
        "env_key": "ANTHROPIC_AUTH_TOKEN",
        "env_key_alt": "ANTHROPIC_API_KEY",
        "env_base": "ANTHROPIC_BASE_URL",
        "default_base": "https://api.anthropic.com",
        "default_model": "claude-sonnet-4-5",
    },
    "openai": {
        "label": "OpenAI 兼容",
        "env_key": "OPENAI_API_KEY",
        "env_key_alt": None,
        "env_base": "OPENAI_BASE_URL",
        "default_base": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
    },
}

_CFG_KEY = "llm:config"


def masked(secret: str) -> str:
    """只暴露尾 4 位，其余打码。"""
    if not secret:
        return ""
    if len(secret) <= 4:
        return "*" * len(secret)
    return "*" * 8 + secret[-4:]


def _load() -> dict:
    with db() as conn:
        row = conn.execute("SELECT value FROM setting WHERE key=?", (_CFG_KEY,)).fetchone()
    if not row:
        return {}
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return {}


def _save(cfg: dict) -> None:
    with tx() as conn:
        conn.execute("INSERT INTO setting(key,value) VALUES(?,?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (_CFG_KEY, json.dumps(cfg)))


def get_provider_config(provider: str) -> dict:
    """返回实际可用的配置（含明文 key）。仅内部调用，绝不外发。"""
    spec = PROVIDERS[provider]
    stored = _load().get(provider, {})

    key = os.environ.get(spec["env_key"]) or (
        os.environ.get(spec["env_key_alt"]) if spec["env_key_alt"] else None)
    source = "env" if key else None
    if not key and stored.get("api_key"):
        key, source = stored["api_key"], "ui"

    base = (os.environ.get(spec["env_base"]) or stored.get("base_url")
            or spec["default_base"])
    model = stored.get("model") or spec["default_model"]
    return {
        "provider": provider,
        "api_key": key,
        "base_url": base,
        "model": model,
        "source": source,
    }


def public_status() -> dict:
    """给前端的脱敏视图。"""
    cfg = _load()
    out = []
    for pid, spec in PROVIDERS.items():
        real = get_provider_config(pid)
        env_set = bool(os.environ.get(spec["env_key"]) or
                       (os.environ.get(spec["env_key_alt"]) if spec["env_key_alt"] else None))
        stored = cfg.get(pid, {})
        out.append({
            "provider": pid,
            "label": spec["label"],
            "configured": bool(real["api_key"]),
            "source": real["source"],            # env / ui / None
            "env_locked": env_set,               # 环境变量存在时不可在 UI 覆盖
            "masked": masked(stored.get("api_key")) if stored.get("api_key") else "",
            "base_url": real["base_url"],
            "model": real["model"],
            "default_base": spec["default_base"],
            "default_model": spec["default_model"],
        })
    return {"providers": out, "active": get_active_provider()}


def save_provider(provider: str, api_key: str | None = None,
                  base_url: str | None = None, model: str | None = None,
                  clear_key: bool = False) -> dict:
    """api_key=None 表示不改动；api_key="" 或 clear_key=True 表示清除。"""
    if provider not in PROVIDERS:
        raise ValueError("未知供应商")
    cfg = _load()
    entry = cfg.get(provider, {})
    if clear_key or (api_key is not None and not api_key.strip()):
        entry.pop("api_key", None)
        entry.pop("saved_at", None)
    elif api_key is not None:
        entry["api_key"] = api_key.strip()
        entry["saved_at"] = now()
    if base_url is not None:
        entry["base_url"] = base_url.strip()
    if model is not None:
        entry["model"] = model.strip()
    cfg[provider] = entry
    _save(cfg)
    return public_status()


def clear_provider(provider: str) -> dict:
    cfg = _load()
    cfg.pop(provider, None)
    _save(cfg)
    return public_status()


def get_active_provider() -> str:
    with db() as conn:
        row = conn.execute("SELECT value FROM setting WHERE key=?",
                           ("llm:active",)).fetchone()
    if row:
        return row["value"]
    # 未设置时自动挑选第一个已配置的
    for pid in PROVIDERS:
        if get_provider_config(pid)["api_key"]:
            return pid
    return "anthropic"


def set_active_provider(provider: str) -> str:
    if provider not in PROVIDERS:
        raise ValueError("未知供应商")
    with tx() as conn:
        conn.execute("INSERT INTO setting(key,value) VALUES(?,?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     ("llm:active", provider))
    return provider
