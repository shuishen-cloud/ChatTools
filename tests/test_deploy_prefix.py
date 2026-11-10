"""部署到 /8000 子路径（deploy-8000）的契约测试。运行：python3 -m tests.test_deploy_prefix

锁定 doc/feat/deploy-8000.md 的核心不变量：

  1. **不设 CHATTOOL_PREFIX 时行为零变化**：首页 HTML 与本机根路径部署完全一致，
     不含任何 `/8000` 痕迹，也不残留 `%%PREFIX%%` 占位符。
  2. **设 CHATTOOL_PREFIX=/8000 时**：所有 `/static/` 引用都带前缀，
     `window.__CT_PREFIX` 被注入为 `/8000`，仍无占位符残留。
  3. **非法/空/带尾斜杠的前缀被规范化**：`/8000/` → `/8000`，
     不以 `/` 开头的 `8000` 补成 `/8000`，避免拼出 `8000/static`（相对路径）。
  4. **前端确有 withPrefix 且被真正使用**：`api()` / SSE / 导出 / 分享 / panels
     五处都过前缀，否则子路径下会请求到根路径 404。
  5. **分享链接不把前缀写进库**：`create_share` 返回的 url 必须是裸 `/s/<token>`，
     前缀只在前端拼——否则将来改路径旧链接全坏。

为什么不真的起 Nginx：prefix 替换发生在应用层（index 渲染），
TestClient 就能完整覆盖；proxy_pass 的改写是运维配置，不属于代码契约。
"""
from __future__ import annotations

import importlib
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="chattool-prefix-"))
os.environ["CHATTOOL_DATA"] = str(TMP)
os.environ.setdefault("CHATTOOL_DB", str(TMP / "test.db"))

sys.path.insert(0, str(ROOT))


def fresh_app(prefix: str | None):
    """按指定 CHATTOOL_PREFIX 重建 app（前缀在模块导入时读取，必须 reload）。"""
    if prefix is None:
        os.environ.pop("CHATTOOL_PREFIX", None)
    else:
        os.environ["CHATTOOL_PREFIX"] = prefix
    for mod in ("app.routes", "app"):
        if mod in sys.modules:
            importlib.reload(sys.modules[mod])
    import app.routes as R
    return R


class PrefixRenderTest(unittest.TestCase):
    """首页 HTML 的前缀替换。"""

    def _html(self, prefix):
        R = fresh_app(prefix)
        from starlette.testclient import TestClient
        return TestClient(R.create_app()).get("/").text

    def test_01_no_prefix_keeps_root_paths(self):
        """不设前缀：静态资源仍是根路径，与部署前逐字节语义一致。"""
        html = self._html(None)
        self.assertIn('href="/static/style.css"', html)
        self.assertIn('src="/static/app.js"', html)
        self.assertNotIn("/8000", html)
        self.assertNotIn("%%PREFIX%%", html)
        # 未设前缀时注入空串，前端 withPrefix 退化为恒等
        self.assertIn('window.__CT_PREFIX = ""', html)

    def test_02_prefix_rewrites_all_static_refs(self):
        """设 /8000：4 个静态引用全部带前缀。"""
        html = self._html("/8000")
        for asset in ('href="/8000/static/style.css"',
                      'src="/8000/static/theme.js"',
                      'src="/8000/static/markdown.js"',
                      'src="/8000/static/panels.js"',
                      'src="/8000/static/app.js"'):
            self.assertIn(asset, html, f"缺少带前缀的引用：{asset}")
        self.assertNotIn("%%PREFIX%%", html, "占位符未被替换，页面会白屏")
        self.assertIn('window.__CT_PREFIX = "/8000"', html)

    def test_03_prefix_normalized(self):
        """尾斜杠 / 缺前导斜杠都要规范化，否则拼出 8000/static 这种相对路径。"""
        self.assertIn('src="/8000/static/app.js"', self._html("/8000/"))
        self.assertIn('src="/8000/static/app.js"', self._html("8000"))

    def test_04_prefix_with_nested_path(self):
        """多级子路径（/tools/chattool）也要能工作，不依赖单段路径。"""
        html = self._html("/tools/chattool")
        self.assertIn('src="/tools/chattool/static/app.js"', html)
        self.assertIn('window.__CT_PREFIX = "/tools/chattool"', html)

    def test_05_static_actually_served(self):
        """Nginx 改写后 /static 由应用服务；这里锁住应用侧确实没加前缀路由。"""
        R = fresh_app("/8000")
        from starlette.testclient import TestClient
        c = TestClient(R.create_app())
        self.assertEqual(c.get("/static/app.js").status_code, 200)
        # 应用侧不认带前缀的路径（由 Nginx 剥掉），删了这层避免重复实现
        self.assertEqual(c.get("/8000/static/app.js").status_code, 404)


class FrontendPrefixTest(unittest.TestCase):
    """前端必须真的用上前缀——只注入不消费等于没做。"""

    @classmethod
    def setUpClass(cls):
        cls.app_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.panels_js = (ROOT / "static" / "panels.js").read_text(encoding="utf-8")
        cls.index_html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")

    def test_10_withprefix_defined_and_exported(self):
        self.assertIn("withPrefix", self.app_js)
        # panels.js 在 app.js 之前加载，只能通过 window 共享
        self.assertIn("__ctWithPrefix", self.app_js)

    def test_11_api_wrapper_uses_prefix(self):
        """api() 是所有 API 的唯一出口，必须带前缀。"""
        body = self.app_js[self.app_js.index("async function api("):]
        head = body[:600]
        self.assertRegex(head, r"fetch\(withPrefix\(",
                         "api() 的 fetch 没走 withPrefix，子路径下全部 404")

    def test_12_sse_and_export_use_prefix(self):
        """流式生成与导出下载是绕过 api() 的两处，必须单独加。"""
        sse = re.search(r"generate`[^\n]*\n[^\n]*", self.app_js)
        self.assertIsNotNone(sse)
        self.assertIn("withPrefix", self.app_js[sse.start() - 120:sse.start() + 120])
        self.assertRegex(self.app_js, r"withPrefix\(`/api/conversations/\$\{.*\}/export")

    def test_13_share_link_uses_prefix(self):
        """分享链接要能点开，否则只读页 404。"""
        self.assertRegex(self.app_js, r"location\.origin \+ withPrefix\(info\.url\)")

    def test_14_panels_uses_window_helper(self):
        self.assertIn("__ctWithPrefix", self.panels_js)
        self.assertNotRegex(self.panels_js, r"fetch\(endpoint[,)]",
                            "panels.js 仍在裸 fetch(endpoint)")

    def test_15_index_has_placeholders(self):
        """占位符必须留在模板里，替换才发生；直接写死会让前缀失效。"""
        self.assertGreaterEqual(self.index_html.count("%%PREFIX%%"), 5)
        self.assertIn("<script>window.__CT_PREFIX", self.index_html)


class ShareUrlStorageTest(unittest.TestCase):
    """分享链接入库不带前缀（见设计 2.4）。"""

    def test_20_share_url_has_no_prefix(self):
        R = fresh_app(None)
        from starlette.testclient import TestClient
        c = TestClient(R.create_app())
        conv = c.post("/api/conversations", json={"title": "前缀测试"}).json()["data"]
        info = c.post(f"/api/conversations/{conv['id']}/share", json={}).json()["data"]
        self.assertTrue(info["url"].startswith("/s/"), info["url"])
        self.assertNotIn("/8000", info["url"])
        R = fresh_app("/8000")
        c2 = TestClient(R.create_app())
        info2 = c2.post(f"/api/conversations/{conv['id']}/share", json={}).json()["data"]
        self.assertTrue(info2["url"].startswith("/s/"),
                        "前缀不该写进库，否则换路径旧链接全坏")


if __name__ == "__main__":
    unittest.main(verbosity=2)
