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
    "deepseek": {
        "label": "DeepSeek",
        # 官方原生接口，OpenAI 兼容协议
        "protocol": "openai",
        "key_group": "deepseek",       # 与 deepseek_anthropic 共享 Key
        "env_key": "DEEPSEEK_API_KEY",
        "env_key_alt": None,
        "env_base": "DEEPSEEK_BASE_URL",
        "default_base": "https://api.deepseek.com/v1",
        "default_model": "deepseek-chat",
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "key_hint": "在 platform.deepseek.com 创建，形如 sk-...",
    },
    "anthropic": {
        "label": "Anthropic (Claude)",
        "protocol": "anthropic",
        "env_key": "ANTHROPIC_AUTH_TOKEN",
        "env_key_alt": "ANTHROPIC_API_KEY",
        "env_base": "ANTHROPIC_BASE_URL",
        "default_base": "https://api.anthropic.com",
        "default_model": "claude-sonnet-4-5",
        "models": ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
        "key_hint": "Anthropic 官方 Key 或兼容网关 Token",
    },
    "deepseek_anthropic": {
        "label": "DeepSeek (Anthropic 兼容)",
        # DeepSeek 同时提供 /anthropic 端点，用 Anthropic 协议调用
        "protocol": "anthropic",
        "key_group": "deepseek",       # 与 deepseek 共享 Key
        "env_key": "DEEPSEEK_API_KEY",
        "env_key_alt": None,
        "env_base": "DEEPSEEK_ANTHROPIC_BASE_URL",
        "default_base": "https://api.deepseek.com/anthropic",
        "default_model": "deepseek-chat",
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "key_hint": "同一个 DeepSeek Key，走 Anthropic 协议端点",
    },
    "openai": {
        "label": "OpenAI 兼容",
        "protocol": "openai",
        "env_key": "OPENAI_API_KEY",
        "env_key_alt": None,
        "env_base": "OPENAI_BASE_URL",
        "default_base": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
        "models": ["gpt-4o", "gpt-4o-mini", "o3-mini"],
        "key_hint": "任意 OpenAI 兼容服务的 Key",
    },
}

# 已配置供应商时的默认优先级（DeepSeek 放前面：本机环境常用）
DEFAULT_ORDER = ["deepseek", "anthropic", "deepseek_anthropic", "openai"]

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


def _group_members(provider: str) -> list[str]:
    """同一供应商的不同协议端点共享 Key（如 deepseek / deepseek_anthropic）。"""
    group = PROVIDERS[provider].get("key_group")
    if not group:
        return [provider]
    return [pid for pid, spec in PROVIDERS.items() if spec.get("key_group") == group]


def get_provider_config(provider: str) -> dict:
    """返回实际可用的配置（含明文 key）。仅内部调用，绝不外发。

    Key 查找顺序：本端点环境变量 → 同组其他端点环境变量
                  → 本端点 UI 存储 → 同组 UI 存储。
    """
    spec = PROVIDERS[provider]
    stored_all = _load()
    stored = stored_all.get(provider, {})
    members = _group_members(provider)

    key = _env_key(spec)
    key_owner = provider if key else None
    if not key:
        for pid in members:
            if pid != provider and _env_key(PROVIDERS[pid]):
                key, key_owner = _env_key(PROVIDERS[pid]), pid
                break
    source = "env" if key else None
    if not key:
        for pid in members:
            cand = stored_all.get(pid, {}).get("api_key")
            if cand:
                key, source, key_owner = cand, "ui", pid
                break

    # base_url / model 不跨端点共享（两个端点地址不同）
    base = (os.environ.get(spec["env_base"]) or stored.get("base_url")
            or spec["default_base"])
    model = stored.get("model") or spec["default_model"]
    return {
        "provider": provider,
        "protocol": spec["protocol"],
        "api_key": key,
        "key_source_provider": key_owner,
        "base_url": base,
        "model": model,
        "source": source,
    }


def _env_key(spec: dict) -> str | None:
    return os.environ.get(spec["env_key"]) or (
        os.environ.get(spec["env_key_alt"]) if spec["env_key_alt"] else None)


def public_status() -> dict:
    """给前端的脱敏视图。"""
    cfg = _load()
    out = []
    for pid in DEFAULT_ORDER:
        spec = PROVIDERS[pid]
        real = get_provider_config(pid)
        env_set = real["source"] == "env"
        stored = cfg.get(pid, {})
        out.append({
            "provider": pid,
            "label": spec["label"],
            "protocol": spec["protocol"],
            "configured": bool(real["api_key"]),
            "source": real["source"],            # env / ui / None
            "env_locked": env_set,               # 环境变量存在时不可在 UI 覆盖
            "key_shared_from": (real["key_source_provider"]
                                if real["key_source_provider"] != pid else None),
            "masked": masked(real["api_key"]) if real["api_key"] else "",
            "base_url": real["base_url"],
            "model": real["model"],
            "default_base": spec["default_base"],
            "default_model": spec["default_model"],
            "models": spec.get("models", []),
            "key_hint": spec.get("key_hint", ""),
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
    if row and row["value"] in PROVIDERS:
        return row["value"]
    # 未设置时自动挑选第一个已配置的（按偏好顺序）
    for pid in DEFAULT_ORDER:
        if get_provider_config(pid)["api_key"]:
            return pid
    return DEFAULT_ORDER[0]


def set_active_provider(provider: str) -> str:
    if provider not in PROVIDERS:
        raise ValueError("未知供应商")
    with tx() as conn:
        conn.execute("INSERT INTO setting(key,value) VALUES(?,?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     ("llm:active", provider))
    return provider
