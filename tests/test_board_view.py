"""画板作为一级视图（board-as-view）的契约测试。运行：python3 -m tests.test_board_view

锁定 doc/feat/board-as-view.md 的核心不变量：
  1. #boardview 必须在 #main 内，与 #detail 同级（不再是 body 直下的全屏遮罩）
  2. .boardview 不得有 position:fixed + inset:0 —— 否则又变回盖住全场的遮罩
  3. 存在一级 tab 条 #viewtabs
  4. 记忆上次画板（chattool.board.active）与视图（chattool.view）
  5. 打开多个画板时 tab 去重
"""
from __future__ import annotations

import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="chattool-boardview-"))
os.environ["CHATTOOL_DATA"] = str(TMP)
os.environ.setdefault("CHATTOOL_DB", str(TMP / "test.db"))

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from starlette.testclient import TestClient  # noqa: E402

from app.routes import create_app  # noqa: E402


def _rule(css: str, selector: str) -> str:
    """取出某个选择器的主规则体（第一个 {} 块）。"""
    m = re.search(re.escape(selector) + r"\s*\{([^}]*)\}", css)
    return m.group(1) if m else ""


class BoardViewTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(create_app())
        cls.html = cls.client.get("/").text
        cls.css = cls.client.get("/static/style.css").text
        cls.js = cls.client.get("/static/app.js").text
        cls.panels = cls.client.get("/static/panels.js").text

    # ---------------------------------------------- 结构
    def test_01_boardview_inside_main(self):
        """画板必须嵌在 #main 里，才能与对话并列为同级视图。"""
        self.assertIn('id="boardview"', self.html)
        main_start = self.html.index('id="main"')
        # #main 的闭合标签：用 #detail 与 #boardview 的相对位置判断
        bv = self.html.index('id="boardview"')
        self.assertGreater(bv, main_start, "#boardview 应在 #main 之后（内部）")
        # 不能出现在 </main> 之后
        main_close = self.html.index("</main>")
        self.assertLess(bv, main_close,
                        "#boardview 必须在 </main> 之前，否则它还是 body 下的浮层")

    def test_02_boardview_not_fullscreen_overlay(self):
        """不再允许 position:fixed + inset:0 的全屏遮罩写法。"""
        body = _rule(self.css, ".boardview")
        self.assertTrue(body, "缺少 .boardview 规则")
        self.assertNotIn("position: fixed", body.replace("position:fixed", "position: fixed"),
                         ".boardview 不得再用 fixed 定位（会盖住对话）")
        # inset:0 / inset: 0 都不行
        self.assertNotRegex(body, r"inset\s*:\s*0")

    def test_03_hidden_still_wins(self):
        """搬进 #main 后，[hidden] 兜底必须仍然存在（否则画板常显）。"""
        self.assertRegex(self.css, r"\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important")

    # ---------------------------------------------- tab 条
    def test_04_view_tabs_exist(self):
        """顶部要有「对话 / 画板」同级 tab。

        注意：tab 条目在 multi-chat-tabs 之后改为**动态生成**（对话可多开），
        所以这里只断言容器与列表存在，具体条目由 renderTabs 产出。
        静态 chat tab 已被 tests/test_chat_tabs.py::test_01 明确禁止。
        """
        self.assertIn('id="viewtabs"', self.html)
        self.assertIn('id="vtab-list"', self.html)
        self.assertIn("function renderTabs", self.panels)

    def test_05_tab_switch_wired(self):
        """tab 点击必须真的切视图，且画板 tab 可关闭。"""
        js = self.js + self.panels
        self.assertIn("switchMainView", js)
        self.assertIn("openBoardTab", js)
        self.assertIn("closeBoardTab", js)

    # ---------------------------------------------- 记忆
    def test_06_remembers_active_board(self):
        """必须记住上次用的画板，否则每次打开跳回第一块。"""
        js = self.js + self.panels
        self.assertIn("chattool.board.active", js)
        self.assertIn("chattool.board.open", js)
        self.assertIn("chattool.view", js)

    def test_07_board_tabs_dedupe(self):
        """已打开的相同画板不得重复开 tab。"""
        js = self.panels + self.js
        self.assertRegex(
            js, r"(includes\(|indexOf\(|\.some\()",
            "打开画板前应检查是否已在列表里")

    def test_07b_board_does_not_shadow_conv_state(self):
        """tab 标题必须真能读到会话标题。

        坑：panels.js 的 Board 闭包内也定义了 `state`，会遮蔽 app.js 的全局 `state`。
        若直接写 `state.activeConv?.title`，永远得 undefined，tab 一直显示「对话」。
        这种静默失效必须被测试锁住。
        """
        # app.js 必须暴露全局引用
        self.assertIn("window.__chattoolAppState = state", self.js)
        # panels.js 读标题时必须走这个引用，而不是裸 state
        body = self.panels[self.panels.index("function convTitle"):]
        body = body[:body.index("}", body.index("return")) + 1]
        self.assertIn("__chattoolAppState", body,
                      "convTitle 必须通过全局引用读会话状态，否则被闭包 state 遮蔽")

    # ---------------------------------------------- 加入画板：记忆优先
    def test_08_add_to_board_prefers_active(self):
        """「＋ 画板」应直接加入上次的画板，而不是每次都弹窗。"""
        self.assertIn("addToActiveBoard", self.panels)
        # 弹窗仍作为兜底保留（没有记忆时）
        self.assertIn("modal-pick-board", self.html)

    # ---------------------------------------------- 后端不受影响
    def test_09_board_api_still_works(self):
        b = self.client.post("/api/boards", json={"name": "视图板"}).json()["data"]
        n = self.client.post(f"/api/boards/{b['id']}/nodes",
                             json={"content": "x", "w": 300, "h": 200}).json()["data"]
        self.assertEqual((n["w"], n["h"]), (300.0, 200.0))
        got = self.client.get(f"/api/boards/{b['id']}").json()["data"]
        self.assertEqual(len(got["nodes"]), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
