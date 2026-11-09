"""HTTP 路由层。"""
from __future__ import annotations

import json
from pathlib import Path

from starlette.applications import Starlette
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import conversations as C
from . import exporting as E
from . import folders as F
from . import settings as S
from .db import init_db
from .exporting import content_disposition
from .generate import api_generate, api_llm_options
from .utils import err, ok, read_json

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"


# ---------------------------------------------------------------- 会话

async def api_conversations(request):
    q = request.query_params
    rows = C.list_conversations(folder_id=q.get("folder"), q=q.get("q"),
                                archived=q.get("archived") in ("1", "true"))
    return ok(rows)


async def api_conv_create(request):
    body = await read_json(request)
    folder_ids = body.get("folder_ids") or ([body["folder_id"]] if body.get("folder_id") else [])
    conv = C.create_conversation(title=body.get("title") or "未命名会话",
                                 model=body.get("model"), source=body.get("source", "local"),
                                 folder_ids=folder_ids, summary=body.get("summary"))
    return ok(conv)


async def api_conv_get(request):
    conv_id = request.path_params["conv_id"]
    conv = C.get_conversation(conv_id)
    if not conv:
        return err("会话不存在", 404)
    msgs = C.get_messages(conv_id)
    conv["messages"] = msgs
    conv["main_branch"] = C.main_branch(msgs)
    return ok(conv)


async def api_conv_update(request):
    conv_id = request.path_params["conv_id"]
    body = await read_json(request)
    conv = C.update_conversation(conv_id, body)
    return ok(conv) if conv else err("会话不存在", 404)


async def api_conv_delete(request):
    C.delete_conversation(request.path_params["conv_id"])
    return ok()


async def api_conv_folders(request):
    conv_id = request.path_params["conv_id"]
    body = await read_json(request)
    return ok({"folder_ids": F.set_conv_folders(conv_id, body.get("folder_ids") or [])})


async def api_conv_link(request):
    conv_id = request.path_params["conv_id"]
    folder_id = request.path_params["folder_id"]
    if request.method == "DELETE":
        F.unlink(conv_id, folder_id)
    else:
        F.link(conv_id, folder_id)
    return ok()


# ---------------------------------------------------------------- 消息

async def api_msg_create(request):
    conv_id = request.path_params["conv_id"]
    body = await read_json(request)
    if "role" not in body:
        return err("缺少 role")
    msg = C.add_message(conv_id, body["role"], body.get("content", ""),
                        body.get("parent_id"), body.get("meta"))
    return ok(msg)


async def api_msg_update(request):
    body = await read_json(request)
    msg = C.update_message(request.path_params["msg_id"], body)
    return ok(msg) if msg else err("消息不存在", 404)


async def api_msg_delete(request):
    cascade = request.query_params.get("cascade", "1") in ("1", "true")
    C.delete_message(request.path_params["msg_id"], cascade=cascade)
    return ok()


async def api_msg_branch_edit(request):
    body = await read_json(request)
    try:
        return ok(C.edit_message_as_branch(request.path_params["msg_id"],
                                           body.get("content", "")))
    except KeyError:
        return err("消息不存在", 404)


async def api_msg_siblings(request):
    return ok(C.siblings(request.path_params["msg_id"]))


async def api_msg_tag(request):
    msg_id = request.path_params["msg_id"]
    if request.method == "DELETE":
        F.remove_tag(msg_id, request.path_params["tag"])
        return ok()
    body = await read_json(request)
    name = request.path_params.get("tag") or body.get("name")
    if not name:
        return err("缺少标签名")
    F.add_tag(msg_id, name, body.get("color", "#8b95a7"))
    return ok()


async def api_favorites(request):
    q = request.query_params
    return ok(C.list_favorites(q.get("q"), q.get("tag")))


async def api_tags(request):
    return ok(F.list_tags())


# ---------------------------------------------------------------- 文件夹

async def api_folders(request):
    if request.query_params.get("tree") in ("1", "true"):
        return ok(F.folder_tree())
    return ok(F.list_folders())


async def api_folder_create(request):
    body = await read_json(request)
    if not body.get("name"):
        return err("缺少名称")
    return ok(F.create_folder(body["name"], body.get("color", "#6b8afd"),
                              body.get("description", ""), body.get("parent_id")))


async def api_folder_update(request):
    body = await read_json(request)
    row = F.update_folder(request.path_params["folder_id"], body)
    return ok(row) if row else err("文件夹不存在", 404)


async def api_folder_delete(request):
    F.delete_folder(request.path_params["folder_id"])
    return ok()


# ---------------------------------------------------------------- 导出 / 分享 / 导入

async def api_export(request):
    conv_id = request.path_params["conv_id"]
    fmt = request.query_params.get("format", "md")
    branch_only = request.query_params.get("branch_only") in ("1", "true")
    try:
        content, mime, fname = E.build_export(conv_id, fmt, branch_only)
    except KeyError:
        return err("会话不存在", 404)
    return Response(content, media_type=mime,
                    headers={"Content-Disposition": content_disposition(fname)})


async def api_share_create(request):
    body = await read_json(request)
    try:
        return ok(E.create_share(request.path_params["conv_id"],
                                 body.get("branch_only", False)))
    except KeyError:
        return err("会话不存在", 404)


async def api_share_revoke(request):
    E.revoke_share(request.path_params["token"])
    return ok()


async def share_page(request):
    token = request.path_params["token"]
    info = E.resolve_share(token)
    if not info:
        return HTMLResponse("<h1>链接已失效</h1>", status_code=404)
    try:
        content, _, _ = E.build_export(info["conv_id"], "html", info.get("branch_only", False))
    except KeyError:
        return HTMLResponse("<h1>会话已删除</h1>", status_code=404)
    return HTMLResponse(content)


async def api_import(request):
    body = await read_json(request)
    payload = body.get("payload")
    if payload is None:
        payload = body
    folder_ids = body.get("folder_ids") or []
    try:
        if body.get("format") == "pi":
            return ok(E.import_pi_session(payload))
        return ok(E.import_payload(payload, folder_ids))
    except Exception as exc:  # noqa: BLE001
        return err(f"导入失败：{exc}")


async def api_llm_status(request):
    return ok(S.public_status())


async def api_llm_save(request):
    body = await read_json(request)
    provider = body.get("provider") or ""
    try:
        status = S.save_provider(provider, body.get("api_key"),
                                 body.get("base_url"), body.get("model"),
                                 clear_key=bool(body.get("clear_key")))
    except ValueError as exc:
        return err(str(exc))
    return ok(status)


async def api_llm_clear(request):
    provider = request.path_params["provider"]
    try:
        return ok(S.clear_provider(provider))
    except ValueError as exc:
        return err(str(exc))


async def api_llm_active(request):
    body = await read_json(request)
    try:
        return ok({"active": S.set_active_provider(body.get("provider") or "")})
    except ValueError as exc:
        return err(str(exc))


async def api_llm_test(request):
    """轻量连通性检查。只返回成功/错误类别，绝不回显 Key。"""
    body = await read_json(request)
    provider = body.get("provider") or S.get_active_provider()
    if provider not in S.PROVIDERS:
        return err("未知供应商")
    cfg = S.get_provider_config(provider)
    if not cfg["api_key"]:
        return err("尚未配置 API Key")
    result = await _probe(cfg)
    return ok(result)


async def _probe(cfg: dict) -> dict:
    """向上游发一个极小的请求验证凭证。不记录、不回显任何密钥。"""
    import httpx

    base = cfg["base_url"].rstrip("/")
    if cfg["protocol"] == "anthropic":
        url = f"{base}/v1/messages"
        headers = {"x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01"}
        payload = {"model": cfg["model"], "max_tokens": 1,
                   "messages": [{"role": "user", "content": "hi"}]}
    else:
        # OpenAI 兼容：base 已含 /v1 时不再重复拼接
        url = f"{base}/chat/completions" if base.endswith("/v1") \
            else f"{base}/v1/chat/completions"
        headers = {"Authorization": f"Bearer {cfg['api_key']}"}
        payload = {"model": cfg["model"], "max_tokens": 1,
                   "messages": [{"role": "user", "content": "hi"}]}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(url, json=payload, headers=headers)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": "网络不可达", "detail": type(exc).__name__}
    if r.status_code == 200:
        return {"ok": True, "reason": "连接正常", "model": cfg["model"]}
    hint = {401: "Key 无效或权限不足", 402: "账户余额不足",
            403: "Key 被拒绝",
            404: "接口路径不存在（检查 base_url）",
            422: "参数不被接受（检查模型名）",
            429: "额度/频率超限"}.get(r.status_code, "上游返回错误")
    return {"ok": False, "reason": hint, "status": r.status_code}


async def api_stats(request):
    from .db import db
    with db() as conn:
        one = lambda sql, a=(): conn.execute(sql, a).fetchone()[0]  # noqa: E731
        data = {
            "conversations": one("SELECT COUNT(*) FROM conversation WHERE archived=0"),
            "archived": one("SELECT COUNT(*) FROM conversation WHERE archived=1"),
            "messages": one("SELECT COUNT(*) FROM message"),
            "favorites": one("SELECT COUNT(*) FROM message WHERE favorite=1"),
            "folders": one("SELECT COUNT(*) FROM folder"),
            "tags": one("SELECT COUNT(*) FROM tag"),
        }
    return ok(data)


# ---------------------------------------------------------------- 静态页

async def index(request):
    return FileResponse(FRONTEND / "index.html")


def create_app() -> Starlette:
    init_db()
    routes = [
        Route("/", index),
        Route("/s/{token}", share_page),
        Route("/api/stats", api_stats),
        Route("/api/llm/status", api_llm_status, methods=["GET"]),
        Route("/api/llm/config", api_llm_save, methods=["PUT"]),
        Route("/api/llm/config/{provider}", api_llm_clear, methods=["DELETE"]),
        Route("/api/llm/active", api_llm_active, methods=["PUT"]),
        Route("/api/llm/test", api_llm_test, methods=["POST"]),
        Route("/api/conversations", api_conversations, methods=["GET"]),
        Route("/api/conversations", api_conv_create, methods=["POST"]),
        Route("/api/conversations/{conv_id}", api_conv_get, methods=["GET"]),
        Route("/api/conversations/{conv_id}", api_conv_update, methods=["PATCH", "PUT"]),
        Route("/api/conversations/{conv_id}", api_conv_delete, methods=["DELETE"]),
        Route("/api/conversations/{conv_id}/folders", api_conv_folders, methods=["PUT"]),
        Route("/api/conversations/{conv_id}/folders/{folder_id}", api_conv_link,
              methods=["POST", "DELETE"]),
        Route("/api/conversations/{conv_id}/messages", api_msg_create, methods=["POST"]),
        Route("/api/conversations/{conv_id}/generate", api_generate, methods=["POST"]),
        Route("/api/llm/options", api_llm_options, methods=["GET"]),
        Route("/api/conversations/{conv_id}/export", api_export, methods=["GET"]),
        Route("/api/conversations/{conv_id}/share", api_share_create, methods=["POST"]),
        Route("/api/shares/{token}", api_share_revoke, methods=["DELETE"]),
        Route("/api/messages/{msg_id}", api_msg_update, methods=["PATCH", "PUT"]),
        Route("/api/messages/{msg_id}", api_msg_delete, methods=["DELETE"]),
        Route("/api/messages/{msg_id}/branch", api_msg_branch_edit, methods=["POST"]),
        Route("/api/messages/{msg_id}/siblings", api_msg_siblings, methods=["GET"]),
        Route("/api/messages/{msg_id}/tags", api_msg_tag, methods=["POST"]),
        Route("/api/messages/{msg_id}/tags/{tag}", api_msg_tag, methods=["DELETE"]),
        Route("/api/favorites", api_favorites, methods=["GET"]),
        Route("/api/tags", api_tags, methods=["GET"]),
        Route("/api/folders", api_folders, methods=["GET"]),
        Route("/api/folders", api_folder_create, methods=["POST"]),
        Route("/api/folders/{folder_id}", api_folder_update, methods=["PATCH", "PUT"]),
        Route("/api/folders/{folder_id}", api_folder_delete, methods=["DELETE"]),
        Route("/api/import", api_import, methods=["POST"]),
        Mount("/static", StaticFiles(directory=ROOT / "static"), name="static"),
    ]
    return Starlette(routes=routes)
