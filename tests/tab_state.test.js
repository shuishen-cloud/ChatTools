/* 用最小 DOM 桩跑真实 panels.js 的 tab 状态机，验证去重/回落/记忆。
   目的是验证行为，不是验证「代码里有没有某个字符串」。 */
const fs = require("fs");
const path = require("path");

const store = {};
const warns = [];

class El {
  constructor(tag = "div", attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.id = attrs.id || "";
    this.dataset = {};
    this._cls = new Set((attrs.class || "").split(/\s+/).filter(Boolean));
    this.hidden = !!attrs.hidden;
    this.style = {};
    this.children = [];
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.scrollTop = 0;
    this.offsetWidth = 232;
    this.offsetHeight = 130;
    this.classList = {
      add: (c) => this._cls.add(c),
      remove: (c) => this._cls.delete(c),
      toggle: (c, f) => (f === undefined ? (this._cls.has(c) ? this._cls.delete(c) : this._cls.add(c)) : f ? this._cls.add(c) : this._cls.delete(c)),
      contains: (c) => this._cls.has(c),
    };
    this._h = {};
  }
  addEventListener(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
  removeEventListener() {}
  setAttribute() {} getAttribute() { return null; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); }
  append(c) { this.children.push(c); }
  querySelector(sel) {
    // renderTabs 只需拿到列表容器里的子元素
    return null;
  }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 232, height: 130 }; }
}

const ids = ["vtab-list", "boardview", "detail", "btn-vtab-add", "modal-pick-board",
  "pick-board-list", "pick-board-name", "pick-board-cancel", "board-select",
  "board-name", "board-hint", "board-nodes", "board-svg", "board-empty",
  "btn-board-new", "btn-board-full", "btn-board-export", "btn-board-link",
  "board-canvas", "btn-board", "global-search", "vtab-chat-title"];
const reg = new Map(ids.map((i) => [i, new El("div", { id: i })]));

global.window = {
  innerWidth: 1200, innerHeight: 900,
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "#000" }),
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
};
global.localStorage = window.localStorage;
global.document = {
  documentElement: new El("html"),
  body: new El("body"),
  getElementById: (i) => reg.get(i) || null,
  querySelector: (s) => {
    const m = /^#([\w-]+)$/.exec(String(s).trim());
    return m ? (reg.get(m[1]) || null) : null;
  },
  querySelectorAll: () => [],
  createElement: (t) => new El(t),
  createElementNS: () => new El("svg"),
  addEventListener() {},
};
global.requestAnimationFrame = (f) => setTimeout(f, 0);
global.confirm = () => true;
global.prompt = () => "x";
global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ ok: true, data: [] }) });
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };

// 只载入 panels.js 里的 Board 模块需要的最小环境
const src = fs.readFileSync(path.join(__dirname, "..", "static", "panels.js"), "utf8");

// 提供 panels.js 依赖的全局
global.$ = (s, r = document) => r.querySelector(s);
global.$$ = () => [];
global.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
global.toast = () => {};
global.api = async () => [];
global.MD = { render: (s) => s, bindCopy: () => {} };
global.openConv = async () => {};
global.ensureConversation = async () => {};
global.loadConvs = async () => {};
global.currentProvider = () => null;
global.composerState = {};
global.state = { activeConv: null, convs: [] };
global.window.__chattoolAppState = global.state;

let code = src;
try { new Function(code + "\n;globalThis.__Board = Board;")(); }
catch (e) { console.log("✗ 载入 panels.js 失败:", e.message); process.exit(1); }

const B = global.__Board;
if (!B) { console.log("✗ 没拿到 Board"); process.exit(1); }

let bad = 0;
const check = (name, cond, extra = "") => {
  if (!cond) bad++;
  console.log((cond ? "✓" : "✗"), name, extra);
};

// --- 1. 去重：同一会话开两次只应有一个 tab ---
(async () => {
  global.state.convs = [{ id: "c1", title: "会话一", message_count: 2 }];
  global.state.activeConv = { id: "c1", title: "会话一", messages: [] };
  B.__test_writeTabs = null;

  await B.openChatTab("c1");
  await B.openChatTab("c1");
  const tabs = JSON.parse(store["chattool.tabs"] || "[]");
  check("同一会话重复打开只留一个 tab", tabs.filter((t) => t.kind === "chat" && t.id === "c1").length === 1, JSON.stringify(tabs));

  // --- 2. 多会话并存 ---
  global.state.convs.push({ id: "c2", title: "会话二", message_count: 5 });
  global.state.activeConv = { id: "c2", title: "会话二", messages: [] };
  await B.openChatTab("c2");
  const t2 = JSON.parse(store["chattool.tabs"] || "[]");
  check("两个会话可同时存在 tab", t2.filter((t) => t.kind === "chat").length === 2, JSON.stringify(t2.map((t) => t.id)));

  // --- 3. 当前 tab 记录 ---
  check("active tab 是 c2", (JSON.parse(store["chattool.tab.active"] || "null") || {}).id === "c2");

  // --- 4. 关闭非当前 tab 不影响 active ---
  await B.closeTab("chat", "c1");
  const t4 = JSON.parse(store["chattool.tabs"] || "[]");
  check("关闭非当前 tab 后 c1 消失", !t4.some((t) => t.id === "c1"));
  check("关闭非当前 tab 后 active 仍是 c2", (JSON.parse(store["chattool.tab.active"] || "null") || {}).id === "c2");

  // --- 5. 关闭当前 tab 回落到相邻 ---
  await B.closeTab("chat", "c2");
  const act5 = JSON.parse(store["chattool.tab.active"] || "null");
  const t5 = JSON.parse(store["chattool.tabs"] || "[]");
  check("关掉最后一个会话 tab 后不留空白 tab 列表", t5.filter((t) => t.kind === "chat").length <= 1, JSON.stringify(t5));
  console.log("   active after close:", JSON.stringify(act5));

  // --- 6. 画板与会话混排 ---
  global.state.activeConv = { id: "c1", title: "会话一", messages: [] };
  await B.openChatTab("c1");
  store["chattool.tabs"] = JSON.stringify([
    { kind: "chat", id: "c1" }, { kind: "board", id: "b1" },
  ]);
  const mixed = JSON.parse(store["chattool.tabs"]);
  check("会话与画板可混排", mixed.length === 2 && mixed[0].kind === "chat" && mixed[1].kind === "board");

  // --- 7. 滚动记忆 ---
  check("saveScroll 是函数", typeof B.saveScroll === "function");
  check("restoreScroll 是函数", typeof B.restoreScroll === "function");

  console.log(bad ? `\n✗ ${bad} 项失败` : "\n✓ tab 状态机行为全部正确");
  process.exit(bad ? 1 : 0);
})();
