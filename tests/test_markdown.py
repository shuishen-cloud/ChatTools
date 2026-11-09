"""服务端 Markdown 渲染测试（用于分享页 / HTML 导出）。"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import markdown as md  # noqa: E402

DANGEROUS = [
    re.compile(r"<script[\s>]", re.I),
    re.compile(r"<iframe[\s>]", re.I),
    re.compile(r"<object[\s>]", re.I),
    re.compile(r"<svg[\s>]", re.I),
    re.compile(r"<\w+[^>]*\son\w+\s*=", re.I),
    re.compile(r"""\shref\s*=\s*["']?\s*javascript:""", re.I),
    re.compile(r"""\ssrc\s*=\s*["']?\s*javascript:""", re.I),
]


class ServerMarkdownTest(unittest.TestCase):
    # ------------------------------------------------ XSS
    def test_xss_payloads(self):
        payloads = [
            "<script>alert(1)</script>",
            '<img src=x onerror=alert(1)>',
            "<iframe src=\"javascript:alert(1)\"></iframe>",
            "<svg/onload=alert(1)>",
            "[click](javascript:alert(1))",
            "[click](JaVaScRiPt:alert(1))",
            '<a href="#" onclick="alert(1)">x</a>',
            "`<img src=x onerror=alert(1)>`",
            "```\n<script>alert(1)</script>\n```",
            "> <script>alert(1)</script>",
            "<details open ontoggle=alert(1)>",
            "![x](javascript:alert(1))",
        ]
        for raw in payloads:
            html = md.render(raw)
            for pat in DANGEROUS:
                self.assertIsNone(pat.search(html),
                                  f"未拦住 {pat.pattern} <- {raw!r} => {html!r}")

    def test_escapes_raw_html(self):
        self.assertIn("&lt;script&gt;", md.render("<script>x</script>"))

    # ------------------------------------------------ 语法
    def test_inline(self):
        self.assertIn("<strong>b</strong>", md.render("**b**"))
        self.assertIn("<em>i</em>", md.render("*i*"))
        self.assertIn("<code>x</code>", md.render("`x`"))
        self.assertIn("<del>d</del>", md.render("~~d~~"))
        self.assertIn("<code>**nb**</code>", md.render("`**nb**`"))

    def test_blocks(self):
        self.assertIn("<h2", md.render("## 标题"))
        self.assertIn("<ul><li>a</li></ul>", md.render("- a"))
        self.assertIn("<ol><li>a</li></ol>", md.render("1. a"))
        self.assertIn("<blockquote>", md.render("> q"))
        self.assertIn("<hr>", md.render("---"))
        self.assertNotIn("<hr>", md.render("***bold italic***"))

    def test_code_block(self):
        out = md.render("```python\nprint('x')\n```")
        self.assertIn("<pre><code>", out)
        self.assertIn("python", out)
        self.assertIn("print(&#x27;x&#x27;)", out)   # 单次转义
        self.assertNotIn("&amp;#x27;", out)          # 不得双重转义
        self.assertNotIn("<h1", md.render("```\n# h\n```"))

    def test_links_and_images(self):
        out = md.render("[a](https://x.com)")
        self.assertIn('href="https://x.com"', out)
        self.assertIn('rel="noopener noreferrer"', out)
        img = md.render("![alt](https://x.com/a.png)")
        self.assertIn('src="https://x.com/a.png"', img)
        self.assertIn('loading="lazy"', img)

    def test_table_and_task(self):
        t = md.render("| A | B |\n|---|---|\n| 1 | 2 |")
        self.assertIn("<table>", t)
        self.assertIn("<th>A</th>", t)
        self.assertIn("<td>1</td>", t)
        k = md.render("- [x] done\n- [ ] todo")
        self.assertIn('class="tasklist"', k)
        self.assertIn("done", k)

    def test_edge_cases(self):
        self.assertEqual(md.render(None), "")
        self.assertEqual(md.render(""), "")
        self.assertIn("a<br>b", md.render("a\nb"))
        self.assertIn("</p><p>", md.render("p1\n\np2"))
        self.assertIsInstance(md.render("```js\nunclosed"), str)

    def test_share_page_renders_markdown(self):
        """端到端：分享页里的 Markdown 应被渲染成 HTML。"""
        import os
        import tempfile

        tmp = tempfile.mkdtemp()
        os.environ["CHATTOOL_DATA"] = tmp
        os.environ["CHATTOOL_DB"] = os.path.join(tmp, "m.db")
        # 重新导入以确保用新 DB
        from app.routes import create_app
        from starlette.testclient import TestClient

        client = TestClient(create_app())
        conv = client.post("/api/conversations", json={"title": "md"}).json()["data"]
        client.post(f"/api/conversations/{conv['id']}/messages",
                    json={"role": "assistant",
                          "content": "## 小标题\n\n**加粗** 与 `代码`\n\n```js\nlet a=1\n```"})
        token = client.post(f"/api/conversations/{conv['id']}/share",
                            json={}).json()["data"]["token"]
        page = client.get(f"/s/{token}").text
        self.assertIn("<h2", page)
        self.assertIn("<strong>加粗</strong>", page)
        self.assertIn("<pre><code>", page)
        self.assertNotIn("## 小标题", page)


if __name__ == "__main__":
    unittest.main(verbosity=2)
