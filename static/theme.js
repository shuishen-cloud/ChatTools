/* 白天 / 黑夜模式
 *
 * 三种模式：
 *   auto  —— 跟随系统（默认），系统切深色时页面自动跟着变
 *   light —— 强制白天
 *   dark  —— 强制黑夜（原有外观）
 *
 * 实际生效的主题落在 <html data-theme="light|dark">，
 * CSS 里 :root 是黑夜变量，html[data-theme="light"] 覆盖为白天变量。
 * index.html 的 <head> 里有一段内联脚本做同样的判定，
 * 保证首帧之前就定好主题（否则会闪一下白/黑）。
 */
const Theme = (() => {
  "use strict";

  const KEY = "chattool.theme";
  const MODES = ["auto", "light", "dark"];
  const ICON = { auto: "🌗", light: "☀️", dark: "🌙" };
  const LABEL = { auto: "跟随系统", light: "白天", dark: "黑夜" };

  /* 惰性取媒体查询：某些环境（如 WebView 恢复、测试桩）里对象会变，
     每次现取比缓存更可靠，代价可忽略 */
  const mql = () => (window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: light)") : null);

  function loadMode() {
    try {
      const v = localStorage.getItem(KEY);
      return MODES.includes(v) ? v : "auto";
    } catch {
      return "auto"; // 隐私模式 / 禁用存储
    }
  }

  function saveMode(mode) {
    try { localStorage.setItem(KEY, mode); } catch { /* 忽略 */ }
  }

  /** 某个模式实际应呈现的主题 */
  function resolve(mode) {
    if (mode === "light") return "light";
    if (mode === "dark") return "dark";
    const q = mql();
    return q && q.matches ? "light" : "dark";
  }

  function current() {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  function apply(mode, { animate = true } = {}) {
    const theme = resolve(mode);
    const root = document.documentElement;

    if (!animate) root.classList.add("no-theme-anim");
    root.dataset.theme = theme;
    root.dataset.themeMode = mode;
    if (!animate) {
      // 强制一次重排，等底色定下来再恢复过渡
      void root.offsetWidth;
      root.classList.remove("no-theme-anim");
    }

    // 让手机浏览器的状态栏 / 系统 UI 也跟着变
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
      if (bg) meta.setAttribute("content", bg);
    }
    renderButton(mode);
    // 画板连线用 SVG 内联色，需要按新主题重绘
    try { window.Board?.refresh?.(); } catch { /* 画板未初始化时忽略 */ }
    return theme;
  }

  function setMode(mode) {
    const next = MODES.includes(mode) ? mode : "auto";
    saveMode(next);
    apply(next);
    return next;
  }

  /** 白天 <-> 黑夜：在自动模式下也能一键切换（切了就变成显式指定） */
  function toggle() {
    const next = current() === "light" ? "dark" : "light";
    setMode(next);
    return next;
  }

  function renderButton(mode = loadMode()) {
    const ico = document.getElementById("btn-theme-ico");
    const btn = document.getElementById("btn-theme");
    const menu = document.getElementById("theme-menu");

    const theme = current();
    if (ico) ico.textContent = mode === "auto" ? ICON[theme] : ICON[mode];
    if (btn) {
      const what = mode === "auto" ? `跟随系统（当前${LABEL[theme]}）` : LABEL[mode];
      btn.title = `白天 / 黑夜模式：${what}，点击切换`;
      btn.setAttribute("aria-label", `当前${LABEL[theme]}模式，点击切换`);
    }
    if (menu) {
      menu.querySelectorAll("button[data-theme-mode]").forEach((b) => {
        const on = b.dataset.themeMode === mode;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
      });
    }
  }

  function closeMenu() {
    const menu = document.getElementById("theme-menu");
    const btn = document.getElementById("btn-theme");
    if (!menu) return;
    menu.classList.remove("open");
    btn?.setAttribute("aria-expanded", "false");
  }

  let longPressed = false;

  function openMenu() {
    const menu = document.getElementById("theme-menu");
    const btn = document.getElementById("btn-theme");
    if (!menu) return;
    menu.classList.add("open");
    btn?.setAttribute("aria-expanded", "true");
  }

  function bind() {
    const btn = document.getElementById("btn-theme");
    const menu = document.getElementById("theme-menu");

    if (btn) {
      // 点击：直接在白天/黑夜之间切换（最常用，手机上也最好按）
      btn.onclick = (e) => {
        e.stopPropagation();
        if (longPressed) { longPressed = false; return; }
        toggle();
        closeMenu();
      };
      // 右键 / 长按：打开三态菜单（跟随系统 / 白天 / 黑夜）
      btn.oncontextmenu = (e) => {
        e.preventDefault();
        openMenu();
      };
      let timer = null;
      btn.addEventListener("pointerdown", () => {
        timer = setTimeout(() => { longPressed = true; openMenu(); }, 500);
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
        btn.addEventListener(ev, () => clearTimeout(timer)));
    }

    if (menu) {
      menu.onclick = (e) => {
        const b = e.target.closest("button[data-theme-mode]");
        if (!b) return;
        e.stopPropagation();
        setMode(b.dataset.themeMode);
        closeMenu();
      };
    }

    document.addEventListener("click", closeMenu);

    // 跟随系统：系统主题变化时若处于 auto 就跟着变
    const q = mql();
    if (q) {
      const onChange = () => { if (loadMode() === "auto") apply("auto", { animate: false }); };
      if (q.addEventListener) q.addEventListener("change", onChange);
      else if (q.addListener) q.addListener(onChange);
    }

    // 多标签页同步
    window.addEventListener("storage", (e) => {
      if (e.key === KEY) apply(loadMode(), { animate: false });
    });

    // 快捷键：Ctrl/⌘ + Shift + L
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        toggle();
      }
    });

    renderButton();
  }

  return {
    bind, apply, setMode, toggle, current,
    get mode() { return loadMode(); },
    resolve,
  };
})();
