/* Markdown 渲染器测试：node tests/markdown.test.js
 * 重点覆盖 XSS 防护与常见语法正确性。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(
  path.join(__dirname, "..", "static", "markdown.js"), "utf8");

// 在沙箱里执行，取回 MD 对象
const sandbox = { navigator: { clipboard: { writeText: async () => {} } } };
vm.createContext(sandbox);
vm.runInContext(code + "\n;globalThis.__MD = MD;", sandbox);
const MD = sandbox.__MD;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expect) {
  const ok = typeof expect === "function" ? expect(actual) : actual === expect;
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push({ name, actual, expect: String(expect) });
  }
}

function contains(name, html, needle) {
  check(name, html.includes(needle), true);
}

function notContains(name, html, needle) {
  const bad = html.includes(needle);
  check(name, bad ? `包含禁止内容: ${needle}` : "ok", "ok");
}

/* ================= XSS 防护（最重要） ================= */

const xssCases = [
  `<script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`,
  `<iframe src="javascript:alert(1)"></iframe>`,
  `<svg/onload=alert(1)>`,
  `[click](javascript:alert(1))`,
  `[click](JaVaScRiPt:alert(1))`,
  `[click](data:text/html;base64,PHNjcmlwdD4=)`,
  `<a href="#" onclick="alert(1)">x</a>`,
  `"><script>alert(1)</script>`,
  `**<script>alert(1)</script>**`,
  '`<img src=x onerror=alert(1)>`',
  `<div style="background:url(javascript:alert(1))">x</div>`,
  `![x](javascript:alert(1))`,
  `<details open ontoggle=alert(1)>`,
  `<!--<script>alert(1)</script>-->`,
];

// 判定标准：不得出现「可执行的」标签与属性。
// 转义后的文本（如 &lt;script&gt; 或 onclick=&quot;...&quot;）是安全的，
// 因此检查的是真实标签/属性形式，而非子串出现与否。
const dangerous = [
  /<script[\s>]/i,
  /<iframe[\s>]/i,
  /<object[\s>]/i,
  /<embed[\s>]/i,
  /<svg[\s>]/i,
  /<\w+[^>]*\son\w+\s*=/i,        // 未转义的 on* 事件属性
  /\shref\s*=\s*["']?\s*javascript:/i,
  /\ssrc\s*=\s*["']?\s*javascript:/i,
  /style\s*=\s*["'][^"']*expression\s*\(/i,
  /style\s*=\s*["'][^"']*url\s*\(\s*["']?\s*javascript:/i,
];

for (const raw of xssCases) {
  const html = MD.render(raw);
  for (const re of dangerous) {
    if (re.test(html)) {
      fail++;
      failures.push({ name: `XSS 未拦住 ${re}`,
                      actual: `输入=${raw.slice(0, 40)} 输出=${html.slice(0, 120)}`,
                      expect: "无危险标签/属性" });
    } else {
      pass++;
    }
  }
}

// raw HTML 必须表现为可见文本而非标签
contains("raw script 显示为文本", MD.render("<script>x</script>") === "" ? "&lt;script&gt;" : MD.render("<script>x</script>"), "&lt;script&gt;");

// 尖括号必须被转义而非原样输出
contains("转义 <", MD.render("<b>hi</b>"), "&lt;b&gt;");

/* ================= 基本语法 ================= */

contains("粗体", MD.render("**bold**"), "<strong>bold</strong>");
contains("斜体", MD.render("*italic*"), "<em>italic</em>");
contains("粗斜体", MD.render("***both***"), "<strong><em>both</em></strong>");
contains("删除线", MD.render("~~del~~"), "<del>del</del>");
contains("行内代码", MD.render("`x = 1`"), "<code>x = 1</code>");
contains("行内代码中的 md 不解析", MD.render("`**not bold**`"),
  "<code>**not bold**</code>");

const h = MD.render("# 标题");
contains("h1", h, "<h1");
contains("h1 内容", h, "标题");

contains("h3", MD.render("### 三级"), "<h3");
contains("无序列表", MD.render("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
contains("有序列表", MD.render("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
contains("引用", MD.render("> quote"), "<blockquote>");
contains("分隔线", MD.render("---"), "<hr>");

// 代码块
const codeBlock = MD.render("```python\nprint('hi')\n```");
contains("代码块 pre", codeBlock, "<pre><code>");
contains("代码块语言", codeBlock, "python");
contains("代码块内容", codeBlock, "print(&#39;hi&#39;)");
contains("复制按钮", codeBlock, "code-copy");

// 代码块内的 markdown 不被解析
const rawCode = MD.render("```\n# not a heading\n**not bold**\n```");
notContains("代码块内不解析标题", rawCode, "<h1");
notContains("代码块内不解析粗体", rawCode, "<strong>");

/* ================= 链接 ================= */

const link = MD.render("[OpenAI](https://openai.com)");
contains("链接 href", link, 'href="https://openai.com"');
contains("链接 target", link, 'target="_blank"');
contains("链接 rel", link, 'rel="noopener noreferrer"');

const rel = MD.render("[内部](/api/stats)");
contains("相对链接", rel, 'href="/api/stats"');
notContains("相对链接不加 target", rel, "target=");

contains("邮件链接", MD.render("[mail](mailto:a@b.com)"), "mailto:a@b.com");

// 裸 URL 自动链接
const auto = MD.render("见 https://example.com/path 说明");
contains("裸链接", auto, 'href="https://example.com/path"');

/* ================= 表格 ================= */

const table = MD.render("| A | B |\n|---|---|\n| 1 | 2 |");
contains("表格", table, "<table>");
contains("表头", table, "<th>A</th>");
contains("单元格", table, "<td>1</td>");
contains("表格滚动容器", table, 'class="table-wrap"');

/* ================= 任务列表 ================= */

const task = MD.render("- [x] 完成\n- [ ] 未完成");
contains("任务列表", task, 'class="tasklist"');
contains("已完成", task, "done");
contains("勾选符号", task, "✓");

/* ================= 图片 ================= */

const img = MD.render("![alt](https://x.com/a.png)");
contains("图片 src", img, 'src="https://x.com/a.png"');
contains("图片 alt", img, 'alt="alt"');
contains("图片 lazy", img, 'loading="lazy"');
// 非 http 图片协议不允许
const badImg = MD.render("![x](javascript:alert(1))");
notContains("非法图片协议", badImg, "<img");

/* ================= 边界情况 ================= */

check("null 安全", MD.render(null), "");
check("undefined 安全", MD.render(undefined), "");
check("空字符串", MD.render(""), "");
contains("CRLF 归一化", MD.render("a\r\nb"), "a<br>b");
check("纯文本", MD.render("hello"), "<p>hello</p>");
contains("段落换行", MD.render("line1\nline2"), "line1<br>line2");
contains("空行分段", MD.render("p1\n\np2"), "</p><p>");

// 深嵌套引用不崩溃
check("嵌套引用", typeof MD.render("> > > deep"), "string");
// 未闭合代码块
check("未闭合代码块", typeof MD.render("```js\nabc"), "string");
contains("未闭合代码块仍渲染", MD.render("```js\nabc"), "abc");

// 大量文本性能粗测
const big = MD.render(("# 标题\n\n**粗** 文本 `code`\n\n- a\n- b\n\n").repeat(200));
check("大文本可用", big.length > 1000, true);

/* ================= 结果 ================= */

console.log(`\nMarkdown 测试：${pass} 通过, ${fail} 失败`);
if (fail) {
  for (const f of failures.slice(0, 20)) {
    console.log(`  ✗ ${f.name}\n    实际: ${f.actual}\n    期望: ${f.expect}`);
  }
  process.exit(1);
}
console.log("全部通过 ✓");
