/* 主题（白天/黑夜）静态检查
 * 1. theme.js 存在且导出 bind/toggle/setMode
 * 2. HTML 里有主题切换按钮、三态菜单、首帧前置脚本（防闪白），并加载 theme.js
 * 3. CSS 同时定义 :root(黑夜) 与 html[data-theme="light"](白天)
 * 4. 两套主题定义了同一组变量（不漏色）
 * 5. 正文里不残留硬编码的十六进制颜色（否则浅色主题下会糊）
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "static", "style.css"), "utf8");
const html = fs.readFileSync(path.join(root, "frontend", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "static", "theme.js"), "utf8");

let bad = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "　" + detail : ""}`);
  if (!ok) bad++;
};

console.log("== theme.js ==");
for (const fn of ["function bind", "function toggle", "function setMode", "function resolve"]) {
  check(fn, js.includes(fn));
}
check("持久化键 chattool.theme", js.includes('"chattool.theme"'));
check("三种模式 auto/light/dark", /\["auto", "light", "dark"\]/.test(js));
check("跟随系统 prefers-color-scheme", js.includes("prefers-color-scheme: light"));

console.log("\n== index.html ==");
check("主题按钮 #btn-theme", /id="btn-theme"/.test(html));
check("三态菜单 data-theme-mode", (html.match(/data-theme-mode=/g) || []).length === 3);
// 前缀可选：服务端会按 CHATTOOL_PREFIX 替换 %%PREFIX%%（根路径部署时为空）
check("加载 theme.js", /<script src="(?:%%PREFIX%%)?\/static\/theme\.js"><\/script>/.test(html));
const prescript = html.slice(0, html.indexOf("<body"));
check("首帧前置主题脚本（防闪白）", /dataset\.theme/.test(prescript));
check("前置脚本在样式表之后 body 之前",
  prescript.includes("chattool.theme"));

console.log("\n== style.css ==");
const rootVars = (css.match(/^:root\s*\{([\s\S]*?)\}/m) || [])[1] || "";
const lightBlock = (css.match(/html\[data-theme="light"\]\s*\{([\s\S]*?)\}/m) || [])[1] || "";
const names = (block) => new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const rv = names(rootVars), lv = names(lightBlock);
check("存在 :root 黑夜变量", rv.size > 10, `${rv.size} 个`);
check("存在 html[data-theme=light] 白天变量", lv.size > 10, `${lv.size} 个`);
// --radius 是几何参数，不参与换肤
const GEOMETRY = new Set(["--radius"]);
const missing = [...rv].filter((k) => !lv.has(k) && !GEOMETRY.has(k));
check("白天主题覆盖了全部黑夜变量", missing.length === 0, missing.join(",") || "");
check("color-scheme 声明", /\bcolor-scheme\s*:\s*dark/.test(css) && /\bcolor-scheme\s*:\s*light/.test(css));

// 正文（主题变量定义之后）不应再有硬编码色
const body = css.slice(css.indexOf('}', css.indexOf('html[data-theme="light"]')) + 1);
const hard = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
check("正文无残留十六进制颜色", hard.length === 0, [...new Set(hard)].join(",") || "0");

console.log(bad ? `\n✗ ${bad} 项失败` : "\n✓ 主题检查全部通过");
process.exit(bad ? 1 : 0);
