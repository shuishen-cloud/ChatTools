"""LLM 调用层：把「会话消息树」翻译成上游请求，并统一推理强度参数。

设计要点：
1. 两种协议（Anthropic / OpenAI 兼容）各自映射，但对外暴露同一套
   `provider / model / effort` 三元组；
2. 推理强度按模型能力做**降级**：不支持就不发该参数，绝不因参数被拒而报错；
3. 只把「当前分支的祖先链」当作上下文发给模型（分支语义的正确含义）；
4. 流式输出，便于前端逐字显示。
"""
from __future__ import annotations

import json
from typing import AsyncIterator

import httpx

from . import settings as S

# 统一的思考强度档位（由弱到强）
EFFORT_LEVELS = ["off", "low", "medium", "high"]

EFFORT_LABELS = {
    "off": "关闭",
    "low": "低",
    "medium": "中",
    "high": "高",
}

# 各协议下的参数映射：
#  - anthropic: thinking.budget_tokens（需同时 max_tokens 大于 budget）
#  - openai:    reasoning_effort
ANTHROPIC_BUDGET = {"low": 2048, "medium": 8192, "high": 24576}
OPENAI_EFFORT = {"low": "low", "medium": "medium", "high": "high"}

# 明确不支持推理参数的模型前缀（发过去会被 400 拒绝）
NO_REASONING_PREFIXES = ("deepseek-chat", "gpt-4o", "gpt-4-turbo", "gpt-3.5")
REASONING_HINTS = ("reasoner", "o1", "o3", "o4", "r1", "thinking")


def model_supports_reasoning(model: str) -> bool:
    m = (model or "").lower()
    if any(m.startswith(p) for p in NO_REASONING_PREFIXES):
        # deepseek-chat 明确不支持；但 deepseek-reasoner 走下面
        return any(h in m for h in REASONING_HINTS)
    return any(h in m for h in REASONING_HINTS)


class LLMError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def build_request(cfg: dict, messages: list[dict], model: str | None,
                  effort: str, system: str | None) -> tuple[str, dict, dict, dict]:
    """返回 (url, headers, payload, info)。info 说明实际生效的参数。"""
    model = model or cfg["model"]
    effort = effort if effort in EFFORT_LEVELS else "medium"
    base = cfg["base_url"].rstrip("/")
    supports = model_supports_reasoning(model)
    effective = effort if supports else "off"
    info = {"model": model, "effort_requested": effort,
            "effort_effective": effective, "reasoning_supported": supports}

    if cfg["protocol"] == "anthropic":
        url = f"{base}/v1/messages"
        headers = {"x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01",
                   "content-type": "application/json"}
        max_tokens = 8192
        payload: dict = {"model": model, "messages": messages, "max_tokens": max_tokens}
        if system:
            payload["system"] = system
        if effective != "off":
            budget = ANTHROPIC_BUDGET[effective]
            # Anthropic 要求 max_tokens > thinking.budget_tokens
            payload["max_tokens"] = max(max_tokens, budget + 2048)
            payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
            # 开启 thinking 时不允许 temperature，省略即用默认
        else:
            payload["temperature"] = 0.7
        info["max_tokens"] = payload["max_tokens"]
    else:
        url = f"{base}/chat/completions" if base.endswith("/v1") \
            else f"{base}/v1/chat/completions"
        headers = {"Authorization": f"Bearer {cfg['api_key']}",
                   "content-type": "application/json"}
        msgs = list(messages)
        if system:
            msgs = [{"role": "system", "content": system}] + msgs
        payload = {"model": model, "messages": msgs, "stream": True}
        if effective != "off":
            payload["reasoning_effort"] = OPENAI_EFFORT[effective]
        else:
            payload["temperature"] = 0.7
        info["max_tokens"] = None
    return url, headers, payload, info


def _parse_sse_line(line: str) -> dict | None:
    if not line.startswith("data:"):
        return None
    data = line[5:].strip()
    if not data or data == "[DONE]":
        return None
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


async def stream_completion(cfg: dict, messages: list[dict], model: str | None,
                            effort: str, system: str | None) -> AsyncIterator[dict]:
    """产出事件：{"type":"text","text":...} / {"type":"thinking","text":...}
    / {"type":"error","message":...} / {"type":"done","info":{...}}
    """
    if not cfg.get("api_key"):
        yield {"type": "error", "message": "尚未配置 API Key，请在 ⚙ 设置中填写"}
        return

    url, headers, payload, info = build_request(cfg, messages, model, effort, system)
    # 开启推理时若上游不支持 stream，会走同一路径；这里统一按流式解析
    payload["stream"] = True

    yield {"type": "start", "info": info}
    chunk_count = 0
    try:
        timeout = httpx.Timeout(connect=15, read=180, write=30, pool=15)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode("utf-8", "replace")[:600]
                    yield {"type": "error",
                           "message": _friendly_error(resp.status_code, body)}
                    return
                async for raw in resp.aiter_lines():
                    evt = _parse_sse_line(raw)
                    if not evt:
                        continue
                    for out in _extract_events(evt, cfg["protocol"]):
                        if out["type"] in ("text", "thinking") and out.get("text"):
                            chunk_count += 1
                        yield out
    except httpx.HTTPError as exc:
        yield {"type": "error", "message": f"网络请求失败：{type(exc).__name__}"}
        return
    yield {"type": "done", "info": {**info, "chunks": chunk_count}}


def _extract_events(evt: dict, protocol: str) -> list[dict]:
    out: list[dict] = []
    if protocol == "anthropic":
        etype = evt.get("type")
        if etype == "content_block_delta":
            delta = evt.get("delta") or {}
            if delta.get("type") == "text_delta":
                out.append({"type": "text", "text": delta.get("text", "")})
            elif delta.get("type") == "thinking_delta":
                out.append({"type": "thinking", "text": delta.get("thinking", "")})
        elif etype == "error":
            out.append({"type": "error",
                        "message": (evt.get("error") or {}).get("message", "上游错误")})
    else:
        if evt.get("error"):
            out.append({"type": "error",
                        "message": (evt["error"] or {}).get("message", "上游错误")})
            return out
        for choice in evt.get("choices") or []:
            delta = choice.get("delta") or {}
            # 部分推理模型把思维链放在 reasoning_content
            rc = delta.get("reasoning_content")
            if rc:
                out.append({"type": "thinking", "text": rc})
            if delta.get("content"):
                out.append({"type": "text", "text": delta["content"]})
    return out


def _friendly_error(status: int, body: str) -> str:
    # 尽量提取上游给的 message，但不整段回显
    detail = ""
    try:
        obj = json.loads(body)
        e = obj.get("error")
        if isinstance(e, dict):
            detail = e.get("message", "")
        elif isinstance(e, str):
            detail = e
        elif obj.get("message"):
            detail = obj["message"]
    except json.JSONDecodeError:
        detail = body.strip()[:200]
    hint = {400: "请求被拒绝（可能是参数或模型名不支持）",
            401: "Key 无效或权限不足",
            402: "账户余额不足",
            403: "Key 被拒绝",
            404: "接口路径不存在，检查 Base URL",
            429: "频率或额度超限，请稍后再试",
            500: "上游服务错误",
            529: "上游过载，请稍后再试"}.get(status, "上游返回错误")
    return f"{hint} (HTTP {status})" + (f"：{detail}" if detail else "")
