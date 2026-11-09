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


if __name__ == "__main__":
    unittest.main(verbosity=2)
