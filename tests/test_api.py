"""ChatTool 端到端 API 测试。运行：python3 -m tests.test_api"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="chattool-test-"))
os.environ["CHATTOOL_DATA"] = str(TMP)
os.environ["CHATTOOL_DB"] = str(TMP / "test.db")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from starlette.testclient import TestClient  # noqa: E402

from app.routes import create_app  # noqa: E402


class ChatToolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(create_app())

    def _post(self, url, body=None):
        r = self.client.post(url, json=body or {})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    # -------------------------------------------------- 基本 CRUD
    def test_01_create_conversation(self):
        conv = self._post("/api/conversations", {"title": "会话 A"})
        self.assertTrue(conv["id"].startswith("c_"))
        self.assertEqual(conv["title"], "会话 A")

    # -------------------------------------------------- 多对多文件夹
    def test_02_many_to_many_folders(self):
        f1 = self._post("/api/folders", {"name": "研究", "color": "#ff0000"})
        f2 = self._post("/api/folders", {"name": "随笔", "color": "#00ff00"})
        conv = self._post("/api/conversations", {"title": "双归属", "folder_ids": [f1["id"]]})
        # 追加第二个文件夹
        r = self.client.put(f"/api/conversations/{conv['id']}/folders",
                            json={"folder_ids": [f1["id"], f2["id"]]})
        self.assertEqual(len(r.json()["data"]["folder_ids"]), 2)
        detail = self.client.get(f"/api/conversations/{conv['id']}").json()["data"]
        self.assertEqual(len(detail["folders"]), 2)
        # 按文件夹过滤
        lst = self.client.get(f"/api/conversations?folder={f2['id']}").json()["data"]
        self.assertIn(conv["id"], [c["id"] for c in lst])
        # 删除文件夹不影响会话
        self.client.delete(f"/api/folders/{f1['id']}")
        detail = self.client.get(f"/api/conversations/{conv['id']}").json()["data"]
        self.assertEqual(len(detail["folders"]), 1)

    # -------------------------------------------------- 分支
    def test_03_branching(self):
        conv = self._post("/api/conversations", {"title": "分支测试"})
        cid = conv["id"]
        m1 = self._post(f"/api/conversations/{cid}/messages", {"role": "user", "content": "Q1"})
        m2 = self._post(f"/api/conversations/{cid}/messages",
                        {"role": "assistant", "content": "A1", "parent_id": m1["id"]})
        # 对 A1 做编辑 -> 生成兄弟分支
        b = self._post(f"/api/messages/{m2['id']}/branch", {"content": "A1 改进版"})
        self.assertEqual(b["parent_id"], m1["id"])
        self.assertNotEqual(b["id"], m2["id"])
        sib = self.client.get(f"/api/messages/{b['id']}/siblings").json()["data"]
        self.assertEqual(sib["total"], 2)
        self.assertEqual(set(sib["items"]), {m2["id"], b["id"]})
        msgs = self.client.get(f"/api/conversations/{cid}").json()["data"]["messages"]
        self.assertEqual(len(msgs), 3)
        # 原消息仍在（历史未被破坏）
        self.assertIn(m2["id"], [m["id"] for m in msgs])

    # -------------------------------------------------- 收藏与标签
    def test_04_favorites_and_tags(self):
        conv = self._post("/api/conversations", {"title": "收藏测试"})
        cid = conv["id"]
        m = self._post(f"/api/conversations/{cid}/messages",
                       {"role": "assistant", "content": "值得收藏的洞见"})
        self.client.patch(f"/api/messages/{m['id']}", json={"favorite": True})
        self._post(f"/api/messages/{m['id']}/tags", {"name": "洞见"})
        favs = self.client.get("/api/favorites").json()["data"]
        self.assertEqual([f["id"] for f in favs], [m["id"]])
        self.assertEqual(favs[0]["tags"], ["洞见"])
        tags = self.client.get("/api/tags").json()["data"]
        self.assertEqual(tags[0]["name"], "洞见")
        # 取消收藏
        self.client.patch(f"/api/messages/{m['id']}", json={"favorite": False})
        self.assertEqual(self.client.get("/api/favorites").json()["data"], [])

    # -------------------------------------------------- 删除子树
    def test_05_delete_cascade(self):
        conv = self._post("/api/conversations", {"title": "删除测试"})
        cid = conv["id"]
        a = self._post(f"/api/conversations/{cid}/messages", {"role": "user", "content": "A"})
        b = self._post(f"/api/conversations/{cid}/messages",
                       {"role": "assistant", "content": "B", "parent_id": a["id"]})
        self.client.post(f"/api/conversations/{cid}/messages",
                         json={"role": "user", "content": "C", "parent_id": b["id"]})
        self.client.delete(f"/api/messages/{b['id']}?cascade=1")
        msgs = self.client.get(f"/api/conversations/{cid}").json()["data"]["messages"]
        self.assertEqual([m["content"] for m in msgs], ["A"])

    # -------------------------------------------------- 导出四格式
    def test_06_exports(self):
        conv = self._post("/api/conversations", {"title": "导出 <测试>"})
        cid = conv["id"]
        self._post(f"/api/conversations/{cid}/messages", {"role": "user", "content": "你好"})
        for fmt in ("md", "json", "html", "txt"):
            r = self.client.get(f"/api/conversations/{cid}/export?format={fmt}")
            self.assertEqual(r.status_code, 200, fmt)
            self.assertTrue(len(r.text) > 20, fmt)
            self.assertIn("filename", r.headers["content-disposition"])
        html_out = self.client.get(f"/api/conversations/{cid}/export?format=html").text
        self.assertNotIn("<测试>", html_out)   # 已转义
        self.assertIn("&lt;测试&gt;", html_out)
        js = json.loads(self.client.get(f"/api/conversations/{cid}/export?format=json").text)
        self.assertEqual(js["messages"][0]["content"], "你好")

    # -------------------------------------------------- 分享链接
    def test_07_share(self):
        conv = self._post("/api/conversations", {"title": "分享测试"})
        cid = conv["id"]
        self._post(f"/api/conversations/{cid}/messages", {"role": "user", "content": "公开内容"})
        share = self._post(f"/api/conversations/{cid}/share", {})
        page = self.client.get(share["url"])
        self.assertEqual(page.status_code, 200)
        self.assertIn("公开内容", page.text)
        self.client.delete(f"/api/shares/{share['token']}")
        self.assertEqual(self.client.get(share["url"]).status_code, 404)

    # -------------------------------------------------- 导入（含 Pi 格式）
    def test_08_import_roundtrip(self):
        conv = self._post("/api/conversations", {"title": "往返"})
        cid = conv["id"]
        self._post(f"/api/conversations/{cid}/messages", {"role": "user", "content": "U1"})
        self._post(f"/api/conversations/{cid}/messages", {"role": "assistant", "content": "A1"})
        payload = json.loads(
            self.client.get(f"/api/conversations/{cid}/export?format=json").text)
        res = self._post("/api/import", {"payload": payload})
        self.assertEqual(res["message_count"], 2)

    def test_09_import_pi(self):
        pi = {
            "title": "Pi 里的会话",
            "model": "claude-sonnet",
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "解释一下闭包"}]},
                {"role": "assistant", "content": "闭包是携带环境的函数。"},
            ],
        }
        res = self._post("/api/import", {"payload": pi, "format": "pi"})
        self.assertEqual(res["message_count"], 2)
        detail = self.client.get(f"/api/conversations/{res['conversation']['id']}").json()["data"]
        self.assertEqual(detail["source"], "pi")
        self.assertEqual(detail["messages"][0]["content"], "解释一下闭包")

    # -------------------------------------------------- 搜索 / 统计 / 归档
    def test_10_search_stats_archive(self):
        conv = self._post("/api/conversations", {"title": "独特关键词ZZQ"})
        cid = conv["id"]
        self._post(f"/api/conversations/{cid}/messages", {"role": "user", "content": "正文包含PLUM"})
        self.assertEqual(
            len(self.client.get("/api/conversations?q=独特关键词").json()["data"]), 1)
        self.assertEqual(
            len(self.client.get("/api/conversations?q=PLUM").json()["data"]), 1)
        stats = self.client.get("/api/stats").json()["data"]
        self.assertGreater(stats["messages"], 0)
        self.client.patch(f"/api/conversations/{cid}", json={"archived": True})
        self.assertNotIn(cid, [c["id"] for c in
                               self.client.get("/api/conversations").json()["data"]])
        self.assertIn(cid, [c["id"] for c in
                            self.client.get("/api/conversations?archived=1").json()["data"]])

    # -------------------------------------------------- 前端资源可访问
    def test_11_frontend_assets(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/static/app.js").status_code, 200)
        self.assertEqual(self.client.get("/static/style.css").status_code, 200)


    # -------------------------------------------------- API Key 设置（安全重点）
    def test_12_llm_key_never_leaks(self):
        """核心安全断言：任何返回体都不得包含明文 Key。"""
        import os
        # 环境变量优先级高于 DB，先清掉以免掩盖 UI 保存的 Key
        for name in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"):
            os.environ.pop(name, None)
        SECRET = "sk-ant-SUPERSECRETVALUE-1234"
        r = self.client.put("/api/llm/config", json={
            "provider": "anthropic", "api_key": SECRET,
            "base_url": "https://api.anthropic.com", "model": "claude-sonnet-4-5",
        })
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(SECRET, r.text)            # 保存响应不回显
        status = self.client.get("/api/llm/status")
        self.assertNotIn(SECRET, status.text)       # 状态接口脱敏
        data = status.json()["data"]
        ant = [p for p in data["providers"] if p["provider"] == "anthropic"][0]
        self.assertTrue(ant["configured"])
        self.assertTrue(ant["masked"].endswith("1234"))
        self.assertNotIn("SUPERSECRET", ant["masked"])
        # 测试连接接口也不得回显
        t = self.client.post("/api/llm/test", json={"provider": "anthropic"})
        self.assertNotIn(SECRET, t.text)

    def test_13_llm_env_wins_over_db(self):
        import os
        os.environ["ANTHROPIC_AUTH_TOKEN"] = "env-token-9999"
        try:
            data = self.client.get("/api/llm/status").json()["data"]
            ant = [p for p in data["providers"] if p["provider"] == "anthropic"][0]
            self.assertEqual(ant["source"], "env")
            self.assertTrue(ant["env_locked"])
        finally:
            os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

    def test_14_llm_clear_and_blank_means_noop(self):
        # 前端的「留空 = 不修改」：根本不会提交 api_key 字段
        self.client.put("/api/llm/config", json={"provider": "openai", "api_key": "sk-openai-7777"})
        self.client.put("/api/llm/config", json={"provider": "openai", "model": "gpt-4o"})
        data = self.client.get("/api/llm/status").json()["data"]
        oa = [p for p in data["providers"] if p["provider"] == "openai"][0]
        self.assertTrue(oa["configured"], "未提交 api_key 时不应清除已有 Key")
        self.assertEqual(oa["model"], "gpt-4o")
        # 显式提交空字符串 = 清除
        self.client.put("/api/llm/config", json={"provider": "openai", "api_key": ""})
        data = self.client.get("/api/llm/status").json()["data"]
        oa = [p for p in data["providers"] if p["provider"] == "openai"][0]
        self.assertFalse(oa["configured"])
        # clear_key 标记也可清除
        self.client.put("/api/llm/config", json={"provider": "openai", "api_key": "sk-x-1"})
        self.client.put("/api/llm/config", json={"provider": "openai", "clear_key": True})
        data = self.client.get("/api/llm/status").json()["data"]
        self.assertFalse([p for p in data["providers"]
                          if p["provider"] == "openai"][0]["configured"])
        # DELETE 路由清除
        self.client.put("/api/llm/config", json={"provider": "openai", "api_key": "sk-y-2"})
        self.client.delete("/api/llm/config/openai")
        data = self.client.get("/api/llm/status").json()["data"]
        self.assertFalse([p for p in data["providers"]
                          if p["provider"] == "openai"][0]["configured"])

    def test_15_llm_unknown_provider(self):
        self.assertEqual(self.client.put("/api/llm/config",
                                         json={"provider": "nope", "api_key": "x"}).status_code, 400)
        self.assertEqual(self.client.put("/api/llm/active",
                                         json={"provider": "nope"}).status_code, 400)

    def test_16_settings_endpoints_require_key(self):
        """未配置 Key 时测试接口应明确报错而非崩溃。"""
        self.client.delete("/api/llm/config/anthropic")
        r = self.client.post("/api/llm/test", json={"provider": "anthropic"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("API Key", r.json()["error"])

    # -------------------------------------------------- DeepSeek 支持
    def test_17_deepseek_provider_present(self):
        data = self.client.get("/api/llm/status").json()["data"]
        ids = [p["provider"] for p in data["providers"]]
        self.assertIn("deepseek", ids)
        self.assertIn("deepseek_anthropic", ids)
        ds = [p for p in data["providers"] if p["provider"] == "deepseek"][0]
        self.assertEqual(ds["protocol"], "openai")
        self.assertEqual(ds["default_base"], "https://api.deepseek.com/v1")
        self.assertEqual(ds["default_model"], "deepseek-chat")
        self.assertIn("deepseek-reasoner", ds["models"])
        dsa = [p for p in data["providers"] if p["provider"] == "deepseek_anthropic"][0]
        self.assertEqual(dsa["protocol"], "anthropic")
        self.assertEqual(dsa["default_base"], "https://api.deepseek.com/anthropic")

    def test_18_deepseek_env_detected(self):
        import os
        os.environ["DEEPSEEK_API_KEY"] = "sk-ds-env-4321"
        try:
            data = self.client.get("/api/llm/status").json()["data"]
            ds = [p for p in data["providers"] if p["provider"] == "deepseek"][0]
            self.assertTrue(ds["configured"])
            self.assertEqual(ds["source"], "env")
            self.assertTrue(ds["env_locked"])
            # 环境变量优先级：自动成为 active（若此前未设）
            self.assertIn(data["active"], ("deepseek", "deepseek_anthropic"))
        finally:
            os.environ.pop("DEEPSEEK_API_KEY", None)

    def test_19_deepseek_key_save_masked(self):
        SECRET = "sk-ds-PLAINTEXT-abcdef9876"
        r = self.client.put("/api/llm/config", json={
            "provider": "deepseek", "api_key": SECRET, "model": "deepseek-reasoner"})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(SECRET, r.text)
        data = self.client.get("/api/llm/status")
        self.assertNotIn(SECRET, data.text)
        ds = [p for p in data.json()["data"]["providers"] if p["provider"] == "deepseek"][0]
        self.assertTrue(ds["configured"])
        self.assertTrue(ds["masked"].endswith("9876"))
        self.assertEqual(ds["model"], "deepseek-reasoner")
        self.client.delete("/api/llm/config/deepseek")

    def test_20_probe_protocol_routing(self):
        """_probe 应按 protocol 选择 URL 与鉴权头，而非按 provider 名硬编码。"""
        import asyncio
        from unittest import mock

        from app.routes import _probe

        captured = {}

        class FakeResp:
            status_code = 200

        class FakeClient:
            def __init__(self, *a, **kw):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                return False
            async def post(self, url, json=None, headers=None):
                captured["url"] = url
                captured["headers"] = headers
                return FakeResp()

        cases = [
            ("openai", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions",
             "Authorization"),
            ("anthropic", "https://api.deepseek.com/anthropic",
             "https://api.deepseek.com/anthropic/v1/messages", "x-api-key"),
        ]
        with mock.patch("httpx.AsyncClient", FakeClient):
            for proto, base, want_url, want_hdr in cases:
                cfg = {"protocol": proto, "api_key": "k-test", "base_url": base,
                       "model": "deepseek-chat", "provider": "deepseek"}
                out = asyncio.run(_probe(cfg))
                self.assertTrue(out["ok"])
                self.assertEqual(captured["url"], want_url, f"{proto} URL 错误")
                self.assertIn(want_hdr, captured["headers"])
                self.assertNotIn("k-test", str(out))  # 探测结果不含 Key

    def test_21_openai_base_without_v1(self):
        """用户填 https://api.deepseek.com（无 /v1）时需自动补全。"""
        import asyncio
        from unittest import mock
        from app.routes import _probe

        captured = {}

        class FakeResp:
            status_code = 401

        class FakeClient:
            def __init__(self, *a, **kw):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                return False
            async def post(self, url, json=None, headers=None):
                captured["url"] = url
                return FakeResp()

        with mock.patch("httpx.AsyncClient", FakeClient):
            out = asyncio.run(_probe({"protocol": "openai", "api_key": "k",
                                      "base_url": "https://api.deepseek.com",
                                      "model": "deepseek-chat"}))
        self.assertEqual(captured["url"],
                         "https://api.deepseek.com/v1/chat/completions")
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], 401)
        self.assertIn("Key", out["reason"])

    def test_22_deepseek_key_group_shared(self):
        """deepseek 与 deepseek_anthropic 是同一供应商的两种协议，应共享 Key。"""
        import os
        for n in ("DEEPSEEK_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
            os.environ.pop(n, None)
        # 1) UI 保存到 deepseek，deepseek_anthropic 也应识别为已配置
        self.client.put("/api/llm/config", json={
            "provider": "deepseek", "api_key": "sk-shared-5555"})
        data = self.client.get("/api/llm/status").json()["data"]
        dsa = [p for p in data["providers"] if p["provider"] == "deepseek_anthropic"][0]
        self.assertTrue(dsa["configured"], "同组 Key 应共享")
        self.assertEqual(dsa["key_shared_from"], "deepseek")
        # 2) 环境变量组内也能跨端点生效
        self.client.delete("/api/llm/config/deepseek")
        os.environ["DEEPSEEK_API_KEY"] = "sk-env-6666"
        try:
            data = self.client.get("/api/llm/status").json()["data"]
            dsa = [p for p in data["providers"] if p["provider"] == "deepseek_anthropic"][0]
            self.assertTrue(dsa["configured"])
            self.assertEqual(dsa["source"], "env")
            self.assertTrue(dsa["env_locked"])
            # 3) 两个端点 base_url 不同，不应串味
            ds = [p for p in data["providers"] if p["provider"] == "deepseek"][0]
            self.assertEqual(ds["base_url"], "https://api.deepseek.com/v1")
            self.assertEqual(dsa["base_url"], "https://api.deepseek.com/anthropic")
        finally:
            os.environ.pop("DEEPSEEK_API_KEY", None)

    # -------------------------------------------------- 生成 / 模型切换（核心修复）
    def test_23_generate_persists_reply(self):
        """发送消息后必须真的产生 assistant 回复并落库（此前的 bug）。"""
        import asyncio
        from unittest import mock

        async def fake_stream(cfg, messages, model, effort, system):
            yield {"type": "start", "info": {"model": model, "effort_requested": effort,
                                             "effort_effective": effort,
                                             "reasoning_supported": True}}
            yield {"type": "text", "text": "你好"}
            yield {"type": "text", "text": "，世界"}
            yield {"type": "done", "info": {"chunks": 2, "effort_effective": effort}}

        conv = self._post("/api/conversations", {"title": "生成测试"})
        cid = conv["id"]
        self.client.put("/api/llm/config", json={"provider": "openai", "api_key": "sk-gen-1"})
        self._post(f"/api/conversations/{cid}/messages", {"role": "user", "content": "打个招呼"})

        with mock.patch("app.llm.stream_completion", fake_stream):
            r = self.client.post(f"/api/conversations/{cid}/generate",
                                 json={"provider": "openai", "model": "deepseek-chat",
                                       "effort": "low"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/event-stream", r.headers["content-type"])
        self.assertIn("你好", r.text)
        # 落库校验
        msgs = self.client.get(f"/api/conversations/{cid}").json()["data"]["messages"]
        roles = [m["role"] for m in msgs]
        self.assertEqual(roles, ["user", "assistant"])
        self.assertEqual(msgs[1]["content"], "你好，世界")
        self.assertEqual(msgs[1]["meta"]["status"], "done")
        self.assertEqual(msgs[1]["meta"]["model"], "deepseek-chat")
        self.client.delete("/api/llm/config/openai")

    def test_23b_autotitle_only_when_default(self):
        """仅当标题仍是默认值时才用首条用户消息自动命名。"""
        import asyncio
        from unittest import mock

        async def fake_stream(cfg, messages, model, effort, system):
            yield {"type": "text", "text": "ok"}
            yield {"type": "done", "info": {}}

        conv = self._post("/api/conversations", {})   # 标题为「未命名会话」
        cid = conv["id"]
        self.client.put("/api/llm/config", json={"provider": "openai", "api_key": "sk-t"})
        self._post(f"/api/conversations/{cid}/messages",
                   {"role": "user", "content": "帮我设计一个数据库"})
        with mock.patch("app.llm.stream_completion", fake_stream):
            self.client.post(f"/api/conversations/{cid}/generate", json={"provider": "openai"})
        title = self.client.get(f"/api/conversations/{cid}").json()["data"]["title"]
        self.assertEqual(title, "帮我设计一个数据库")
        self.client.delete("/api/llm/config/openai")

    def test_24_generate_requires_key(self):
        import os
        for n in ("OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                  "ANTHROPIC_API_KEY"):
            os.environ.pop(n, None)
        # 清空 DB 中所有已存 Key，确保真的「无 Key」
        for prov in ("openai", "deepseek", "anthropic", "deepseek_anthropic"):
            self.client.delete(f"/api/llm/config/{prov}")
        conv = self._post("/api/conversations", {"title": "无 Key"})
        self._post(f"/api/conversations/{conv['id']}/messages",
                   {"role": "user", "content": "hi"})
        r = self.client.post(f"/api/conversations/{conv['id']}/generate",
                             json={"provider": "openai"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("API Key", r.json()["error"])

    def test_25_generate_records_error_not_crash(self):
        import asyncio
        from unittest import mock

        async def bad_stream(cfg, messages, model, effort, system):
            yield {"type": "error", "message": "Key 无效或权限不足 (HTTP 401)"}

        conv = self._post("/api/conversations", {"title": "错误"})
        cid = conv["id"]
        self.client.put("/api/llm/config", json={"provider": "openai", "api_key": "sk-bad"})
        self._post(f"/api/conversations/{cid}/messages", {"role": "user", "content": "q"})
        with mock.patch("app.llm.stream_completion", bad_stream):
            r = self.client.post(f"/api/conversations/{cid}/generate",
                                 json={"provider": "openai"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("401", r.text)
        msgs = self.client.get(f"/api/conversations/{cid}").json()["data"]["messages"]
        assistant = [m for m in msgs if m["role"] == "assistant"][0]
        self.assertEqual(assistant["meta"]["status"], "error")
        self.assertIn("401", assistant["meta"]["error"])
        self.client.delete("/api/llm/config/openai")

    def test_26_llm_options_for_switcher(self):
        data = self.client.get("/api/llm/options").json()["data"]
        self.assertIn("providers", data)
        self.assertIn("efforts", data)
        self.assertEqual([e["value"] for e in data["efforts"]],
                         ["off", "low", "medium", "high"])
        ds = [p for p in data["providers"] if p["provider"] == "deepseek"][0]
        self.assertIn("deepseek-reasoner", ds["models"])

    def test_27_free_tier_effort_downgrade(self):
        """模型不支持推理时应降级为 off，且不把参数字段发上去。"""
        from app import llm
        cfg = {"protocol": "anthropic", "api_key": "k",
               "base_url": "https://api.deepseek.com/anthropic"}
        _, _, payload, info = llm.build_request(cfg, [{"role": "user", "content": "x"}],
                                               "deepseek-chat", "high", None)
        self.assertEqual(info["effort_effective"], "off")
        self.assertNotIn("thinking", payload)
        # 支持推理的模型应真发参数
        _, _, payload2, info2 = llm.build_request(cfg, [{"role": "user", "content": "x"}],
                                                 "deepseek-reasoner", "high", None)
        self.assertEqual(info2["effort_effective"], "high")
        self.assertIn("thinking", payload2)
        self.assertGreater(payload2["max_tokens"], payload2["thinking"]["budget_tokens"])

    def test_28_branch_context_only_ancestors(self):
        """生成上下文只能包含当前分支祖先链，不能把兄弟分支混进来。"""
        from app.generate import branch_context
        conv = self._post("/api/conversations", {"title": "上下文"})
        cid = conv["id"]
        u = self._post(f"/api/conversations/{cid}/messages",
                       {"role": "user", "content": "主线问题"})
        a1 = self._post(f"/api/conversations/{cid}/messages",
                        {"role": "assistant", "content": "答案一", "parent_id": u["id"]})
        # 在 u 下再开一条分支（兄弟）
        a2 = self._post("/api/messages/" + a1["id"] + "/branch", {"content": "答案二"})
        ctx1 = branch_context(cid, a1["id"])
        ctx2 = branch_context(cid, a2["id"])
        # 末尾可能补一条 "请继续。" 以确保以 user 结尾
        self.assertEqual([m["content"] for m in ctx1][:2], ["主线问题", "答案一"])
        self.assertEqual([m["content"] for m in ctx2][:2], ["主线问题", "答案二"])
        self.assertEqual(ctx1[-1]["role"], "user")
        # 两条分支互不可见
        self.assertNotIn("答案二", str(ctx1))
        self.assertNotIn("答案一", str(ctx2))

    def test_29_protocol_event_parsing(self):
        from app.llm import _extract_events
        # anthropic
        self.assertEqual(
            _extract_events({"type": "content_block_delta",
                             "delta": {"type": "text_delta", "text": "hi"}}, "anthropic"),
            [{"type": "text", "text": "hi"}])
        self.assertEqual(
            _extract_events({"type": "content_block_delta",
                             "delta": {"type": "thinking_delta", "thinking": "想"}}, "anthropic"),
            [{"type": "thinking", "text": "想"}])
        # openai + reasoning_content
        ev = _extract_events({"choices": [{"delta": {"reasoning_content": "推", "content": "答"}}]},
                             "openai")
        self.assertEqual(ev, [{"type": "thinking", "text": "推"},
                              {"type": "text", "text": "答"}])

    # -------------------------------------------------- 右侧历史树
    def test_30_thread_tree(self):
        conv = self._post("/api/conversations", {"title": "历史树"})
        cid = conv["id"]
        u = self._post(f"/api/conversations/{cid}/messages",
                       {"role": "user", "content": "第一条问题"})
        a = self._post(f"/api/conversations/{cid}/messages",
                       {"role": "assistant", "content": "第一个回答", "parent_id": u["id"]})
        # 造一个分支
        self._post(f"/api/messages/{a['id']}/branch", {"content": "分支回答"})
        data = self.client.get(f"/api/conversations/{cid}/thread").json()["data"]
        self.assertEqual(data["total"], 3)
        self.assertEqual(len(data["roots"]), 1)
        root = data["roots"][0]
        self.assertEqual(root["preview"], "第一条问题")
        # u 下面有两个子节点：回答 a 与 a 的分支（branch_edit 建在 u 下）
        self.assertEqual(len(root["children"]), 2)
        self.assertEqual(root["branch_count"], 2)
        self.assertIn("main_branch", data)
        self.assertEqual(len(data["main_branch"]), 2)   # 主线只含 2 条

    def test_31_thread_preview_truncated(self):
        conv = self._post("/api/conversations", {"title": "长文本"})
        long_text = "很长" * 100
        self._post(f"/api/conversations/{conv['id']}/messages",
                   {"role": "user", "content": long_text})
        data = self.client.get(f"/api/conversations/{conv['id']}/thread").json()["data"]
        preview = data["roots"][0]["preview"]
        self.assertLessEqual(len(preview), 61)
        self.assertTrue(preview.endswith("…"))

    # -------------------------------------------------- 画板
    def test_32_board_crud(self):
        board = self._post("/api/boards", {"name": "研究脉络"})
        self.assertTrue(board["id"].startswith("b_"))
        boards = self.client.get("/api/boards").json()["data"]
        self.assertIn(board["id"], [b["id"] for b in boards])
        # 改名
        r = self.client.patch(f"/api/boards/{board['id']}", json={"name": "改名后"})
        self.assertEqual(r.json()["data"]["name"], "改名后")

    def test_33_board_nodes_and_edges(self):
        board = self._post("/api/boards", {"name": "连线"})
        bid = board["id"]
        conv = self._post("/api/conversations", {"title": "来源"})
        m1 = self._post(f"/api/conversations/{conv['id']}/messages",
                        {"role": "user", "content": "节点一"})
        m2 = self._post(f"/api/conversations/{conv['id']}/messages",
                        {"role": "assistant", "content": "节点二"})
        n1 = self._post(f"/api/boards/{bid}/nodes", {"message_id": m1["id"]})
        n2 = self._post(f"/api/boards/{bid}/nodes", {"message_id": m2["id"]})
        # 不同节点应自动错开坐标
        self.assertNotEqual((n1["x"], n1["y"]), (n2["x"], n2["y"]))
        # 重复添加同一消息应幂等
        dup = self._post(f"/api/boards/{bid}/nodes", {"message_id": m1["id"]})
        self.assertEqual(dup["id"], n1["id"])
        self.assertEqual(len(self.client.get(f"/api/boards/{bid}").json()["data"]["nodes"]), 2)
        # 连线 + 关系标签
        e = self._post(f"/api/boards/{bid}/edges",
                       {"from_node": n1["id"], "to_node": n2["id"], "label": "导致"})
        self.assertEqual(e["label"], "导致")
        detail = self.client.get(f"/api/boards/{bid}").json()["data"]
        self.assertEqual(len(detail["edges"]), 1)
        self.assertEqual(detail["nodes"][0]["content"], "节点一")
        self.assertEqual(detail["nodes"][0]["conv_title"], "来源")
        # 同方向重复连线应更新而非新增
        self._post(f"/api/boards/{bid}/edges",
                   {"from_node": n1["id"], "to_node": n2["id"], "label": "细化了"})
        detail = self.client.get(f"/api/boards/{bid}").json()["data"]
        self.assertEqual(len(detail["edges"]), 1)
        self.assertEqual(detail["edges"][0]["label"], "细化了")
        # 自连应被拒绝
        r = self.client.post(f"/api/boards/{bid}/edges",
                             json={"from_node": n1["id"], "to_node": n1["id"]})
        self.assertEqual(r.status_code, 400)

    def test_34_board_node_move_and_delete(self):
        board = self._post("/api/boards", {"name": "拖拽"})
        bid = board["id"]
        conv = self._post("/api/conversations", {"title": "x"})
        m = self._post(f"/api/conversations/{conv['id']}/messages",
                       {"role": "user", "content": "移动我"})
        n = self._post(f"/api/boards/{bid}/nodes", {"message_id": m["id"]})
        r = self.client.patch(f"/api/board-nodes/{n['id']}", json={"x": 500, "y": 300})
        self.assertEqual((r.json()["data"]["x"], r.json()["data"]["y"]), (500, 300))
        # 备注
        r = self.client.patch(f"/api/board-nodes/{n['id']}", json={"note": "核心论点"})
        self.assertEqual(r.json()["data"]["note"], "核心论点")
        # 删除节点后连线级联删除（用另一条消息建第二个节点）
        m_b = self._post(f"/api/conversations/{conv['id']}/messages",
                         {"role": "assistant", "content": "第二个"})
        n2 = self._post(f"/api/boards/{bid}/nodes", {"message_id": m_b["id"]})
        self.client.post(f"/api/boards/{bid}/edges",
                         json={"from_node": n["id"], "to_node": n2["id"], "label": "x"})
        self.client.delete(f"/api/board-nodes/{n['id']}")
        detail = self.client.get(f"/api/boards/{bid}").json()["data"]
        self.assertEqual(len(detail["nodes"]), 1)
        self.assertEqual(len(detail["edges"]), 0, "删除节点应级联删连线")

    def test_35_board_survives_message_delete(self):
        """消息被删除后，画板节点应保留但标记为失效引用。"""
        board = self._post("/api/boards", {"name": "失效"})
        conv = self._post("/api/conversations", {"title": "会被删"})
        m = self._post(f"/api/conversations/{conv['id']}/messages",
                       {"role": "user", "content": "临时"})
        self._post(f"/api/boards/{board['id']}/nodes", {"message_id": m["id"]})
        self.client.delete(f"/api/messages/{m['id']}")
        detail = self.client.get(f"/api/boards/{board['id']}").json()["data"]
        self.assertEqual(len(detail["nodes"]), 1)
        self.assertTrue(detail["nodes"][0]["missing"])

    def test_36_board_export_markdown(self):
        board = self._post("/api/boards", {"name": "导出板"})
        conv = self._post("/api/conversations", {"title": "来源会话"})
        m1 = self._post(f"/api/conversations/{conv['id']}/messages",
                        {"role": "user", "content": "论点 A"})
        m2 = self._post(f"/api/conversations/{conv['id']}/messages",
                        {"role": "assistant", "content": "论点 B"})
        n1 = self._post(f"/api/boards/{board['id']}/nodes", {"message_id": m1["id"]})
        n2 = self._post(f"/api/boards/{board['id']}/nodes", {"message_id": m2["id"]})
        self.client.patch(f"/api/board-nodes/{n1['id']}", json={"note": "起始点"})
        self._post(f"/api/boards/{board['id']}/edges",
                   {"from_node": n1["id"], "to_node": n2["id"], "label": "推导出"})
        r = self.client.get(f"/api/boards/{board['id']}/export")
        self.assertEqual(r.status_code, 200)
        text = r.text
        self.assertIn("导出板", text)
        self.assertIn("论点 A", text)
        self.assertIn("起始点", text)
        self.assertIn("-->|推导出|", text)

    def test_37_board_delete_cascades(self):
        board = self._post("/api/boards", {"name": "待删"})
        conv = self._post("/api/conversations", {"title": "x"})
        m = self._post(f"/api/conversations/{conv['id']}/messages",
                       {"role": "user", "content": "y"})
        self._post(f"/api/boards/{board['id']}/nodes", {"message_id": m["id"]})
        self.client.delete(f"/api/boards/{board['id']}")
        self.assertEqual(self.client.get(f"/api/boards/{board['id']}").status_code, 404)

    # -------------------------------------------------- 悬浮提问
    def test_38_snippet_ask_streams_and_saves(self):
        import asyncio
        from unittest import mock

        async def fake_stream(cfg, messages, model, effort, system):
            # 引文与问题必须在 prompt 里
            prompt = messages[0]["content"]
            assert "引文" in prompt and "为何" in prompt
            yield {"type": "text", "text": "因为"}
            yield {"type": "text", "text": "如此"}
            yield {"type": "done", "info": {}}

        self.client.put("/api/llm/config",
                        json={"provider": "openai", "api_key": "sk-snip"})
        conv = self._post("/api/conversations", {"title": "悬浮"})
        cid = conv["id"]
        m = self._post(f"/api/conversations/{cid}/messages",
                       {"role": "assistant", "content": "这段内容值得追问"})
        with mock.patch("app.llm.stream_completion", fake_stream):
            r = self.client.post(f"/api/conversations/{cid}/ask", json={
                "source_text": "这段内容值得追问",
                "question": "为何重要？",
                "message_id": m["id"],
                "provider": "openai",
            })
        self.assertEqual(r.status_code, 200)
        # 流式分块输出，拼接后应为完整答案
        self.assertIn("因为", r.text)
        self.assertIn("如此", r.text)
        # 已保存为独立记录
        snippets = self.client.get(f"/api/conversations/{cid}/snippets").json()["data"]
        self.assertEqual(len(snippets), 1)
        self.assertEqual(snippets[0]["question"], "为何重要？")
        self.assertEqual(snippets[0]["answer"], "因为如此")
        self.assertEqual(snippets[0]["status"], "done")
        self.assertEqual(snippets[0]["message_id"], m["id"])
        # 不应污染主对话消息树
        msgs = self.client.get(f"/api/conversations/{cid}").json()["data"]["messages"]
        self.assertEqual(len(msgs), 1)
        self.client.delete("/api/llm/config/openai")

    def test_39_snippet_requires_input(self):
        conv = self._post("/api/conversations", {"title": "空"})
        r = self.client.post(f"/api/conversations/{conv['id']}/ask",
                             json={"source_text": "", "question": ""})
        self.assertEqual(r.status_code, 400)
        r2 = self.client.post(f"/api/conversations/{conv['id']}/ask",
                              json={"source_text": "有内容", "question": ""})
        self.assertEqual(r2.status_code, 400)

    def test_40_snippet_delete(self):
        conv = self._post("/api/conversations", {"title": "删提问"})
        import asyncio
        from unittest import mock

        async def fake(cfg, m, model, effort, system):
            yield {"type": "text", "text": "ans"}
            yield {"type": "done", "info": {}}

        self.client.put("/api/llm/config",
                        json={"provider": "openai", "api_key": "sk-d"})
        cid = conv["id"]
        with mock.patch("app.llm.stream_completion", fake):
            self.client.post(f"/api/conversations/{cid}/ask",
                             json={"source_text": "x", "question": "q", "provider": "openai"})
        items = self.client.get(f"/api/conversations/{cid}/snippets").json()["data"]
        self.client.delete(f"/api/snippets/{items[0]['id']}")
        self.assertEqual(
            self.client.get(f"/api/conversations/{cid}/snippets").json()["data"], [])
        self.client.delete("/api/llm/config/openai")

if __name__ == "__main__":
    unittest.main(verbosity=2)
