"""对话生成接口：把消息树当前分支转成上下文，流式返回回复。"""
from __future__ import annotations

import json

from starlette.responses import StreamingResponse

from . import conversations as C
from . import llm as L
from . import settings as S
from .db import db, tx
from .utils import err, new_id, now, ok, read_json

DEFAULT_SYSTEM = (
    "你是一个乐于助人的助手。回答要准确、简洁，条理清晰。"
)


def branch_context(conv_id: str, leaf_id: str | None) -> list[dict]:
    """取「根 → leaf」的祖先链，转换为上游需要的 messages。

    若 leaf_id 为空，取最新叶子（即主分支）。
    """
    with db() as conn:
        if not leaf_id:
            rows = conn.execute(
                "SELECT id FROM message WHERE conv_id=? ORDER BY created_at DESC",
                (conv_id,)).fetchall()
            if not rows:
                return []
            # 取最新创建的叶子节点
            for r in rows:
                has_kid = conn.execute(
                    "SELECT 1 FROM message WHERE parent_id=? LIMIT 1", (r["id"],)).fetchone()
                if not has_kid:
                    leaf_id = r["id"]
                    break
            leaf_id = leaf_id or rows[0]["id"]

        chain = C.path_to_root(conn, leaf_id)
        rows = []
        for mid in chain:
            m = conn.execute(
                "SELECT role, content FROM message WHERE id=?", (mid,)).fetchone()
            if m:
                rows.append({"role": m["role"], "content": m["content"]})

    # 上游只接受 user/assistant 交替；system 与 tool 需要归并
    out: list[dict] = []
    for m in rows:
        role = m["role"]
        content = (m["content"] or "").strip()
        if not content:
            continue
        if role == "system":
            # 系统消息并入最近的 user 回合之前，作为普通 user 文本更稳妥
            out.append({"role": "user", "content": f"[系统说明] {content}"})
        elif role == "tool":
            out.append({"role": "user", "content": f"[工具输出] {content}"})
        else:
            out.append({"role": role, "content": content})

    # 合并连续同角色消息（部分上游要求严格交替）
    merged: list[dict] = []
    for m in out:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] += "\n\n" + m["content"]
        else:
            merged.append(dict(m))
    # 确保以 user 结尾（生成回复的前提）
    if merged and merged[-1]["role"] == "assistant":
        merged.append({"role": "user", "content": "请继续。"})
    return merged


async def api_generate(request):
    """POST /api/conversations/{id}/generate

    body: {leaf_id?, provider?, model?, effort?, system?}
    返回 SSE 流：event 内嵌 JSON 行。
    """
    conv_id = request.path_params["conv_id"]
    body = await read_json(request)
    conv = C.get_conversation(conv_id)
    if not conv:
        return err("会话不存在", 404)

    provider = body.get("provider") or S.get_active_provider()
    if provider not in S.PROVIDERS:
        return err("未知供应商")
    cfg = S.get_provider_config(provider)
    if not cfg["api_key"]:
        return err(f"{S.PROVIDERS[provider]['label']} 尚未配置 API Key", 400)

    effort = body.get("effort") or "medium"
    model = body.get("model") or cfg["model"]
    leaf_id = body.get("leaf_id")
    system = body.get("system")
    if system is None:
        system = conv.get("summary") or DEFAULT_SYSTEM

    ctx = branch_context(conv_id, leaf_id)
    if not ctx:
        return err("会话为空，先发一条消息")

    # 预先创建占位 assistant 消息，便于中途失败也能看到输出
    msg_id = new_id("m_")
    meta = {"provider": provider, "model": model, "effort": effort,
            "protocol": cfg["protocol"], "status": "streaming"}

    async def event_stream():
        collected: list[str] = []
        thinking: list[str] = []
        final_info: dict = {}
        failed = False
        try:
            with tx() as conn:
                # 新回复挂在当前分支末端
                parent = leaf_id
                if not parent:
                    last = conn.execute(
                        "SELECT id FROM message WHERE conv_id=? ORDER BY created_at DESC LIMIT 1",
                        (conv_id,)).fetchone()
                    parent = last["id"] if last else None
                conn.execute(
                    "INSERT INTO message(id,conv_id,parent_id,role,content,meta,created_at)"
                    " VALUES(?,?,?,?,?,?,?)",
                    (msg_id, conv_id, parent, "assistant", "", json.dumps(meta), now()))
                C.touch(conn, conv_id)

            yield _sse({"type": "message_created", "id": msg_id, "parent_id": leaf_id})

            async for evt in L.stream_completion(cfg, ctx, model, effort, system):
                if evt["type"] == "start":
                    final_info = evt["info"]
                elif evt["type"] == "thinking":
                    thinking.append(evt["text"])
                elif evt["type"] == "text":
                    collected.append(evt["text"])
                elif evt["type"] == "error":
                    failed = True
                    meta["status"] = "error"
                    meta["error"] = evt["message"]
                    yield _sse({"type": "error", "message": evt["message"]})
                elif evt["type"] == "done":
                    meta.update({k: v for k, v in evt["info"].items()
                                 if k in ("effort_effective", "reasoning_supported")})
                    final_info.update(evt["info"])
                yield _sse(evt)

            text = "".join(collected)
            if thinking:
                meta["thinking"] = "".join(thinking)
            if not failed:
                meta["status"] = "done" if text.strip() else "empty"
            meta["usage_chars"] = len(text)

            with tx() as conn:
                conn.execute("UPDATE message SET content=?, meta=? WHERE id=?",
                             (text, json.dumps(meta), msg_id))
                C.touch(conn, conv_id)

            # 自动命名：首条回复完成后给会话一个可辨识的标题
            if not failed and text.strip():
                _maybe_autotitle(conv_id)

            yield _sse({"type": "saved", "id": msg_id, "info": final_info,
                        "chars": len(text)})
        except Exception as exc:  # noqa: BLE001
            meta["status"] = "error"
            meta["error"] = type(exc).__name__
            with tx() as conn:
                conn.execute("UPDATE message SET meta=? WHERE id=?",
                             (json.dumps(meta), msg_id))
            yield _sse({"type": "error", "message": f"生成中断：{type(exc).__name__}"})
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _maybe_autotitle(conv_id: str) -> None:
    """用首条用户消息的前 24 字命名，仅在标题仍是默认值时。"""
    with db() as conn:
        row = conn.execute("SELECT title FROM conversation WHERE id=?", (conv_id,)).fetchone()
        if not row or row["title"] not in ("未命名会话", ""):
            return
        first = conn.execute(
            "SELECT content FROM message WHERE conv_id=? AND role='user'"
            " ORDER BY created_at ASC LIMIT 1", (conv_id,)).fetchone()
        if not first or not first["content"].strip():
            return
        title = first["content"].strip().splitlines()[0][:24]
    with tx() as conn:
        conn.execute("UPDATE conversation SET title=? WHERE id=?", (title, conv_id))


async def api_llm_options(request):
    """给前端底部模型切换器用的选项。"""
    status = S.public_status()
    providers = [{
        "provider": p["provider"],
        "label": p["label"],
        "configured": p["configured"],
        "default_model": p["default_model"],
        "models": p["models"],
        "active": p["provider"] == status["active"],
    } for p in status["providers"]]
    return ok({
        "providers": providers,
        "efforts": [{"value": v, "label": L.EFFORT_LABELS[v]} for v in L.EFFORT_LEVELS],
        "default_effort": "medium",
    })
