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

if __name__ == "__main__":
    unittest.main(verbosity=2)
