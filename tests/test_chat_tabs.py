"""多对话 tab（multi-chat-tabs）契约测试。

对应 doc/feat/multi-chat-tabs.md：
  1. 对话 tab 不再写死在 HTML，改为统一动态渲染（对话与画板共用一套）
  2. 统一 tab 存储：chattool.tabs / chattool.tab.active
  3. 同一会话不重复开 tab
  4. 关闭当前对话 tab 不让界面空着
  5. 切回会话时恢复上次阅读位置（锚点消息）
  6. 打开会话后刷新 tab（标题同步）
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="chattool-chattabs-"))
os.environ["CHATTOOL_DATA"] = str(TMP)
os.environ.setdefault("CHATTOOL_DB", str(TMP / "test.db"))

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from starlette.testclient import TestClient  # noqa: E402

from app.routes import create_app  # noqa: E402


class ChatTabsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(create_app())
        cls.html = cls.client.get("/").text
        cls.css = cls.client.get("/static/style.css").text
        cls.js = cls.client.get("/static/app.js").text
        cls.panels = cls.client.get("/static/panels.js").text

    # ---------------------------------------------- 结构
    def test_01_no_static_chat_tab(self):
        """对话 tab 必须动态渲染，不能写死在 HTML 里（否则只能有一个）。"""
        self.assertIn('id="viewtabs"', self.html)
        self.assertNotIn('data-viewtab="chat"', self.html,
                         "静态 chat tab 必须移除，改由 renderTabs 统一生成")

    def test_02_single_tab_list_container(self):
        """对话与画板共用一个 tab 容器。"""
        self.assertIn('id="vtab-list"', self.html)
        # 旧的画板专用容器不应再单独存在
        self.assertNotIn('id="vtab-boards"', self.html)

    def test_03_one_render_function(self):
        """只保留一个 tab 渲染入口，不得两套分叉。"""
        self.assertIn("function renderTabs", self.panels)
        # 不能再有"画板专用"的第二个渲染函数
        self.assertNotRegex(self.panels, r"function renderBoardTabs\b")

    # ---------------------------------------------- 存储
    def test_04_unified_tab_keys(self):
        js = self.js + self.panels
        self.assertIn("chattool.tabs", js)
        self.assertIn("chattool.tab.active", js)

    def test_05_tab_entries_have_kind(self):
        """tab 条目必须带 kind，区分会话与画板。"""
        js = self.panels + self.js
        self.assertRegex(js, r'kind\s*[:=]\s*"chat"')
        self.assertRegex(js, r'kind\s*[:=]\s*"board"')

    # ---------------------------------------------- 行为
    def test_06_dedupe_when_opening_chat(self):
        """同一会话重复打开应切到已有 tab，而不是新增。"""
        js = self.js + self.panels
        self.assertIn("openChatTab", js)

    def test_07_closing_active_chat_does_not_leave_blank(self):
        """关掉当前对话 tab 后必须回到某个会话，界面不能空。"""
        body = self.panels[self.panels.index("function closeTab"):]
        body = body[:2000] if len(body) > 2000 else body
        # 关完要能回落到相邻项或新建会话
        self.assertTrue(
            "ensureConversation" in body or "openConv" in body or "openChatTab" in body,
            "关闭当前 tab 后需要有回落逻辑")

    def test_08_scroll_memory(self):
        """切回会话时恢复阅读位置（锚点消息优先于纯像素）。

        tab 切换逻辑统一在 panels.js 的 Board 闭包里，所以检查那里。
        """
        js = self.panels
        self.assertIn("function saveScroll", js)
        self.assertIn("function restoreScroll", js)
        # 必须用锚点消息，而不是只存像素（高度会变，纯像素会飘）
        self.assertIn("anchorId", js)
        self.assertIn("scrollIntoView", js)

    def test_09_render_tabs_after_open(self):
        """打开会话后要刷新 tab，否则标题不同步。"""
        body = self.js[self.js.index("async function openConv"):]
        body = body[:1500]
        self.assertIn("renderTabs", body)

    def test_10_css_for_unified_tabs(self):
        for cls in (".vtab", ".vtab.active", ".vtab-add"):
            self.assertIn(cls, self.css)

    # ---------------------------------------------- 不破坏已有能力
    def test_11_board_tab_still_works(self):
        self.assertIn("openBoardTab", self.panels)
        self.assertIn("switchMainView", self.panels)


if __name__ == "__main__":
    unittest.main(verbosity=2)
