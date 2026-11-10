/* 主题切换逻辑测试：用最小 DOM 打桩跑 static/theme.js
 * 验证 auto 跟随系统、显式指定、一键切换三种行为 */
const store = {};
const el = (id) => ({ id, textContent: "", title: "", classList: { _s: new Set(),
  add(c){this._s.add(c)}, remove(c){this._s.delete(c)}, contains(c){return this._s.has(c)}, toggle(c,on){ on?this._s.add(c):this._s.delete(c) } },
  dataset: {}, setAttribute(){}, querySelectorAll: () => [], offsetWidth: 1 });
const nodes = {};
global.document = {
  documentElement: Object.assign(el("html"), { dataset: {} }),
  getElementById: (id) => (nodes[id] = nodes[id] || el(id)),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener(){},
};
let lightSystem = false;
global.window = { matchMedia: () => ({ matches: lightSystem, addEventListener(){} }), addEventListener(){} };
global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = v) };
global.getComputedStyle = () => ({ getPropertyValue: () => "#f5f6fa" });
global.setTimeout = global.setTimeout; global.clearTimeout = global.clearTimeout;

const src = require("fs").readFileSync("static/theme.js", "utf8");
eval(src + "\nglobal.Theme = Theme;");


const d = document.documentElement;
let bad = 0;
const expect = (label, mode, theme) => {
  const m = localStorage.getItem("chattool.theme") || "auto";
  const ok = m === mode && d.dataset.theme === theme;
  console.log(`  ${ok ? "✓" : "✗"} ${label}　mode=${m} theme=${d.dataset.theme}`);
  if (!ok) bad++;
};

Theme.apply("auto");
expect("auto · 系统为暗 → 黑夜", "auto", "dark");
lightSystem = true;
Theme.apply("auto");
expect("auto · 系统为亮 → 白天", "auto", "light");
Theme.setMode("dark");
expect("显式 dark（系统仍为亮）", "dark", "dark");
Theme.setMode("light");
expect("显式 light", "light", "light");
Theme.toggle();
expect("toggle → 黑夜", "dark", "dark");
Theme.toggle();
expect("toggle → 白天", "light", "light");
console.log(bad ? `\n✗ ${bad} 项失败` : "\n✓ 主题切换逻辑全部通过");
process.exit(bad ? 1 : 0);
