"""画板融入系统（board-integration）的契约测试。

对应 doc/feat/board-integration.md：
  1. 画板可归类到文件夹（多对多），一个画板可入多个
  2. 全量替换语义；删除文件夹后画板仍在、关联清理
  3. GET /api/boards 返回 folders 与 node_count
  4. 节点尺寸按内容推荐（避免一律 232px）
  5. 用户显式指定的尺寸不被推荐值覆盖
  6. 前端：侧栏有画板 tab；节点正文走 MD.render；颜色有面板
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="chattool-boardint-"))
os.environ["CHATTOOL_DATA"] = str(TMP)
os.environ.setdefault("CHATTOOL_DB", str(TMP / "test.db"))

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from starlette.testclient import TestClient  # noqa: E402

from app.routes import create_app  # noqa: E402


class BoardIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(create_app())
        cls.html = cls.client.get("/").text
        cls.css = cls.client.get("/static/style.css").text
        cls.js = cls.client.get("/static/app.js").text
        cls.panels = cls.client.get("/static/panels.js").text

    def _post(self, url, body=None):
        r = self.client.post(url, json=body or {})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["data"]

    # ------------------------------------------------ 1. 归类到文件夹
    def test_01_board_can_join_multiple_folders(self):
        """一个画板可同时属于多个文件夹（与会话一致的多对多）。"""
        b = self._post("/api/boards", {"name": "归类板"})
        f1 = self._post("/api/folders", {"name": "论文"})
        f2 = self._post("/api/folders", {"name": "复盘"})

        r = self.client.put(f"/api/boards/{b['id']}/folders",
                            json={"folder_ids": [f1["id"], f2["id"]]})
        self.assertEqual(r.status_code, 200, r.text)
        ids = set(r.json()["data"]["folder_ids"])
        self.assertEqual(ids, {f1["id"], f2["id"]})

        got = self.client.get(f"/api/boards/{b['id']}/folders").json()["data"]
        self.assertEqual({x["id"] for x in got}, {f1["id"], f2["id"]})
        # 带颜色，供列表 chip 用
        self.assertTrue(all(x.get("color") for x in got))

    def test_02_put_replaces_not_appends(self):
        """PUT 是全量替换：传一个新集合，旧关联必须消失。"""
        b = self._post("/api/boards", {"name": "替换板"})
        a = self._post("/api/folders", {"name": "A"})
        c = self._post("/api/folders", {"name": "B"})
        self.client.put(f"/api/boards/{b['id']}/folders", json={"folder_ids": [a["id"]]})
        r = self.client.put(f"/api/boards/{b['id']}/folders", json={"folder_ids": [c["id"]]})
        ids = set(r.json()["data"]["folder_ids"])
        self.assertEqual(ids, {c["id"]})
        self.assertNotIn(a["id"], ids)

    def test_03_delete_folder_keeps_board(self):
        """删文件夹：关联级联清掉，但画板本体与节点不能丢。"""
        b = self._post("/api/boards", {"name": "幸存板"})
        f = self._post("/api/folders", {"name": "临时"})
        self._post(f"/api/boards/{b['id']}/nodes", {"content": "节点还在"})
        self.client.put(f"/api/boards/{b['id']}/folders", json={"folder_ids": [f["id"]]})

        self.client.delete(f"/api/folders/{f['id']}")

        board = self.client.get(f"/api/boards/{b['id']}").json()["data"]
        self.assertEqual(board["name"], "幸存板")
        self.assertEqual(board["folders"], [])
        self.assertEqual(len(board["nodes"]), 1)

    def test_04_list_boards_has_folders_and_counts(self):
        """侧栏列表要直接拿到 folders / node_count，不必逐块再查。"""
        b = self._post("/api/boards", {"name": "列表板"})
        f = self._post("/api/folders", {"name": "列表夹"})
        self.client.put(f"/api/boards/{b['id']}/folders", json={"folder_ids": [f["id"]]})
        boards = self.client.get("/api/boards").json()["data"]
        one = next(x for x in boards if x["id"] == b["id"])
        self.assertIn("folders", one)
        self.assertEqual([x["id"] for x in one["folders"]], [f["id"]])
        self.assertIn("node_count", one)

    # ------------------------------------------------ 2. 尺寸推荐
    def test_05_short_content_uses_narrow_width(self):
        b = self._post("/api/boards", {"name": "宽度板"})
        n = self._post(f"/api/boards/{b['id']}/nodes", {"content": "短句"})
        self.assertEqual(n["w"], 232.0)

    def test_06_long_or_rich_content_uses_wider_width(self):
        """长文本 / 代码 / 表格不该被硬塞进 232px。"""
        b = self._post("/api/boards", {"name": "宽内容板"})
        long_text = "这是一段很长的说明文字。" * 40
        n1 = self._post(f"/api/boards/{b['id']}/nodes", {"content": long_text})
        self.assertGreater(n1["w"], 232.0)

        code = "说明\n```python\nprint(1)\n```\n"
        n2 = self._post(f"/api/boards/{b['id']}/nodes", {"content": code})
        self.assertGreaterEqual(n2["w"], 320.0)

        table = "| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n"
        n3 = self._post(f"/api/boards/{b['id']}/nodes", {"content": table})
        self.assertGreaterEqual(n3["w"], 400.0)

    def test_07_explicit_width_is_respected(self):
        """用户/前端显式给了宽度，推荐值不得覆盖。"""
        b = self._post("/api/boards", {"name": "显式板"})
        n = self._post(f"/api/boards/{b['id']}/nodes",
                       {"content": "x" * 500, "w": 260})
        self.assertEqual(n["w"], 260.0)

    def test_08_message_node_gets_width_from_message_content(self):
        """引用消息时 content 字段为空，宽度应取自消息正文而不是空串。"""
        conv = self._post("/api/conversations", {"title": "W"})
        m = self._post(f"/api/conversations/{conv['id']}/messages",
                       {"role": "user", "content": "很长的内容" * 60})
        b = self._post("/api/boards", {"name": "引用宽度板"})
        n = self._post(f"/api/boards/{b['id']}/nodes",
                       {"message_id": m["id"], "conv_id": conv["id"]})
        self.assertGreater(n["w"], 232.0)

    # ------------------------------------------------ 3. 前端契约
    def test_09_sidebar_has_boards_tab(self):
        """侧栏必须能列出画板（与右侧列表对应）。"""
        self.assertIn('data-view="boards"', self.html)
        self.assertIn('data-pane="boards"', self.html)
        self.assertIn('id="board-list"', self.html)

    def test_10_node_body_renders_markdown(self):
        """节点正文必须走 MD.render，而不是 escape 后当纯文本。"""
        # 不能是 escape 后直接塞进 .bnode-text
        self.assertNotIn('<div class="bnode-text">${esc(n.content', self.panels)
        # 取 .bnode-text 开头到下一个 </div> 的片段，其中必须出现 MD.render
        idx = self.panels.index('class="bnode-text')
        chunk = self.panels[idx:idx + 400]
        self.assertIn("MD.render(n.content)", chunk,
                      "节点正文必须用 MD.render 渲染，与对话里一致")

    def test_11_color_palette_instead_of_cycling(self):
        """颜色用点选的色板，不是循环猜下一个。"""
        self.assertIn("bnode-palette", self.panels)
        self.assertIn("bnode-palette", self.css)
        # 旧实现的特征：indexOf(color) 然后取下一个
        self.assertNotIn("const idx = colors.indexOf(n.color)", self.panels)

    def test_12_board_node_md_styles_constrained(self):
        """节点内的代码块/表格不能撑破卡片宽度。"""
        self.assertRegex(self.css, r"\.bnode-text[^{]*pre[^{]*\{[^}]*overflow-x")
        self.assertRegex(self.css, r"\.bnode-text[^{]*img[^{]*\{[^}]*max-width")


if __name__ == "__main__":
    unittest.main(verbosity=2)
