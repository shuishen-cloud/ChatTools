/* 右侧对话历史快速切换：把消息树渲染成可点击、可折叠的脉络 */
const ThreadView = (() => {
  "use strict";

  const state = { tree: null, mainBranch: new Set(), collapsed: new Set(), activeId: null };

  const ROLE_ICON = { user: "👤", assistant: "🤖", system: "⚙️", tool: "🔧" };

  function render(container) {
    if (!state.tree) return;
    const roots = state.tree.roots || [];
    container.innerHTML = "";
    if (!roots.length) {
      container.innerHTML = '<p class="hint" style="padding:10px">暂无消息</p>';
      return;
    }
    for (const r of roots) {
      container.appendChild(renderNode(r, 0));
    }
    markActive();
  }

  function renderNode(node, depth) {
    const wrap = document.createElement("div");
    wrap.className = "th-node";

    const isOffBranch = state.mainBranch.size && !state.mainBranch.has(node.id);
    const hasKids = node.children && node.children.length > 0;
    const isCollapsed = state.collapsed.has(node.id);

    const item = document.createElement("div");
    item.className = "th-item" + (isOffBranch ? " offbranch" : "")
      + (node.id === state.activeId ? " active" : "");
    item.dataset.id = node.id;
    item.title = node.preview;

    const icon = ROLE_ICON[node.role] || "·";
    const badges = [];
    if (node.favorite) badges.push("⭐");
    if (node.status === "error") badges.push("⚠");
    if (node.branch_count > 1) badges.push(`🔀${node.branch_count}`);

    item.innerHTML = `
      <span class="th-role">${hasKids ? (isCollapsed ? "▸" : "▾") : "&nbsp;"}</span>
      <span class="th-role">${icon}</span>
      <span class="th-text">${esc(node.preview || "（空）")}</span>
      ${badges.length ? `<span class="th-badge">${badges.join(" ")}</span>` : ""}`;

    item.onclick = (e) => {
      // 点击箭头只折叠，不跳转
      const clickedArrow = e.target.classList.contains("th-role")
        && e.target.textContent.trim() === (isCollapsed ? "▸" : "▾");
      if (clickedArrow && hasKids) {
        if (isCollapsed) state.collapsed.delete(node.id);
        else state.collapsed.add(node.id);
        render($("#thread-tree"));
        return;
      }
      jumpTo(node.id);
    };
    wrap.appendChild(item);

    if (hasKids && !isCollapsed) {
      const kids = document.createElement("div");
      kids.className = "th-kids";
      if (node.children.length > 1) {
        const split = document.createElement("div");
        split.className = "th-split";
        split.textContent = `🔀 ${node.children.length} 个分支`;
        kids.appendChild(split);
      }
      for (const k of node.children) {
        kids.appendChild(renderNode(k, depth + 1));
      }
      wrap.appendChild(kids);
    }
    return wrap;
  }

  function jumpTo(msgId) {
    const el = document.querySelector(`.msg[data-id="${msgId}"]`);
    if (!el) {
      // 该消息可能在折叠的旁支里，先展开全部分支再找
      if (!state.showAllBranchesHint) {
        state.showAllBranchesHint = true;
        toast("该消息在旁支中，已为你展开全部分支");
      }
      if (typeof revealAllBranches === "function") revealAllBranches();
      setTimeout(() => {
        document.querySelector(`.msg[data-id="${msgId}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 60);
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 900);
  }

  /** 滚动时高亮最靠上的可见消息 */
  function markActive() {
    if (!state.activeId) return;
    const items = document.querySelectorAll(".th-item");
    items.forEach((el) => el.classList.toggle("active", el.dataset.id === state.activeId));
  }

  function setActiveFromScroll() {
    const msgs = [...document.querySelectorAll(".msg[data-id]")];
    if (!msgs.length) return;
    const mid = window.innerHeight * 0.4;
    let best = null;
    for (const m of msgs) {
      const r = m.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= 0) best = m;
    }
    if (!best) best = msgs[0];
    const id = best.dataset.id;
    if (id !== state.activeId) {
      state.activeId = id;
      markActive();
      const target = document.querySelector(`.th-item[data-id="${id}"]`);
      if (target) {
        const box = $("#thread-tree");
        const tb = target.getBoundingClientRect();
        const bb = box.getBoundingClientRect();
        if (tb.top < bb.top || tb.bottom > bb.bottom) {
          target.scrollIntoView({ block: "nearest" });
        }
      }
    }
  }

  async function load(convId) {
    state.tree = await api(`/api/conversations/${convId}/thread`);
    state.mainBranch = new Set(state.tree.main_branch || []);
    state.collapsed.clear();
    state.activeId = null;
    $("#thread-count").textContent = `${state.tree.total} 条`;
    render($("#thread-tree"));
  }

  function clear() {
    state.tree = null;
    $("#thread-tree").innerHTML = "";
    $("#thread-count").textContent = "";
  }

  return { load, render, clear, setActiveFromScroll, jumpTo };
})();

/* ---------------------------------------------------------------- 悬浮提问 */
const AskPanel = (() => {
  "use strict";

  const state = {
    open: false,
    convId: null,
    messageId: null,
    sourceText: "",
    streaming: false,
    abort: null,
    history: [],
    lastQuestion: "",
    lastAnswer: "",
    lastQuote: "",
  };

  function bubbleEl() {
    let el = $("#ask-bubble");
    if (!el) {
      el = document.createElement("div");
      el.id = "ask-bubble";
      el.className = "ask-bubble";
      el.hidden = true;
      el.innerHTML = '<button data-act="ask-selection">💬 就此提问</button>';
      document.body.appendChild(el);
    }
    return el;
  }

  function ensurePanel() {
    let panel = $("#ask-panel");
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = "ask-panel";
    panel.className = "ask-panel";
    panel.innerHTML = `
      <div class="ask-panel-head" id="ask-drag">
        <span class="t" id="ask-title">悬浮提问</span>
        <button class="ask-head-btn" id="ask-to-board" title="把这段问答加入画板">
          ＋ 画板</button>
        <button class="ask-head-btn" id="ask-new">新提问</button>
        <button class="ask-head-btn" id="ask-close">✕</button>
      </div>
      <div class="ask-body" id="ask-body"></div>
      <div class="ask-pending" id="ask-pending" hidden></div>
      <div class="ask-input-row">
        <textarea id="ask-input" rows="2" placeholder="针对选中内容提问…"></textarea>
        <button class="btn primary" id="ask-send">问</button>
      </div>`;
    document.body.appendChild(panel);

    positionPanel(panel);
    makeDraggable(panel, $("#ask-drag"));

    $("#ask-close").onclick = close;
    $("#ask-new").onclick = () => {
      state.sourceText = "";
      state.messageId = null;
      state.lastAnswer = "";
      $("#ask-title").textContent = "悬浮提问";
      renderHome();
      $("#ask-input").focus();
    };
    $("#ask-send").onclick = submit;
    $("#ask-to-board").onclick = () => sendToBoard();
    $("#ask-input").onkeydown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    };
    return panel;
  }

  /* 首次出现的默认位置：右下角，留出边距 */
  function positionPanel(panel) {
    const w = 400, h = 460, pad = 16;
    const left = Math.max(pad, window.innerWidth - w - pad);
    const top = Math.max(60, window.innerHeight - h - pad);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  /* 拖动标题栏移动窗口（不影响内部文本选择） */
  function makeDraggable(panel, handle) {
    let drag = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;   // 按钮不触发拖动
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const w = panel.offsetWidth || 400;
      const h = panel.offsetHeight || 460;
      const x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - w);
      const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 40);
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    });
    handle.addEventListener("pointerup", (e) => {
      drag = null;
      handle.releasePointerCapture?.(e.pointerId);
    });
  }

  /* 把「引文 + 问题 + 回答」三者作为一条消息加入画板 */
  async function sendToBoard() {
    // 悬浮问答是独立的：不需要会话，也不需要写进任何对话
    const question = state.lastQuestion || "";
    const answer = state.lastAnswer || "";
    const quote = state.lastQuote || "";
    if (!question) return toast("先提问，再把它加入画板");

    const content = [
      quote ? `> 引文：${quote.slice(0, 300)}` : "",
      "",
      `**问：** ${question}`,
      "",
      answer ? `**答：**\n${answer}` : "**答：**（无回答）",
    ].filter(Boolean).join("\n");

    await Board.addText(content, question.slice(0, 40));
    toast("已把这条问答加入画板");
  }

  /* 选中文本 → 显示浮动按钮 */
  function bindSelection() {
    const bubble = bubbleEl();
    bubble.querySelector("button").onclick = () => {
      const sel = window.getSelection();
      const text = (sel ? String(sel).trim() : "");
      bubble.hidden = true;
      if (!text) return;
      openWith(text);
    };

    document.addEventListener("mouseup", (e) => {
      if (state.open && $("#ask-panel")?.contains(e.target)) return;
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel ? String(sel).trim() : "";
        if (!text || text.length < 2) {
          bubble.hidden = true;
          return;
        }
        // 只在消息区域内生效
        const anchor = sel.anchorNode;
        const host = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
        const msgEl = host?.closest?.(".msg");
        if (!msgEl) {
          bubble.hidden = true;
          return;
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        bubble.dataset.msgId = msgEl.dataset.id;
        bubble.hidden = false;
        bubble.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, 70), window.innerWidth - 70)}px`;
        bubble.style.top = `${rect.top - 8}px`;
      }, 10);
    });

    document.addEventListener("mousedown", (e) => {
      if (!bubble.contains(e.target)) bubble.hidden = true;
    });
    document.addEventListener("scroll", () => (bubble.hidden = true), true);
  }

  function openWith(text, question = "") {
    const bubble = bubbleEl();
    state.convId = state.activeConv?.id || bubble.dataset.msgId ? state.activeConv?.id : null;
    state.messageId = bubble.dataset.msgId || null;
    state.sourceText = text;
    const panel = ensurePanel();
    // 若窗口已在屏幕外（窗口缩放后），重新定位
    const r = panel.getBoundingClientRect();
    if (!panel.classList.contains("open") || r.top < 0 || r.left < 0
        || r.left > window.innerWidth - 60 || r.top > window.innerHeight - 40) {
      positionPanel(panel);
    }
    panel.classList.add("open");
    state.open = true;
    $("#ask-title").textContent = "悬浮提问";
    // 记下待提问的引文；真正的渲染在 submit 时追加
    renderCompose(question);
    if (!question) $("#ask-input").focus();
  }

  /** 每轮问答在窗口里追加一块，而不是清空重来 */
  function appendTurn(quote, question, answerHtml) {
    const body = $("#ask-body");
    // 首次使用时清掉引导文案
    const hint = body.querySelector(".ask-empty-hint");
    if (hint) hint.remove();

    const turn = document.createElement("div");
    turn.className = "ask-turn";
    turn.innerHTML = `
      <div class="ask-quote">${esc(quote.slice(0, 1200))}${
        quote.length > 1200 ? "…" : ""}</div>
      ${question ? `<div class="ask-q">${esc(question)}</div>` : ""}
      <div class="ask-a md">${answerHtml || ""}</div>`;
    body.appendChild(turn);
    body.scrollTop = body.scrollHeight;
    return turn;
  }

  /** 只更新最后一轮引文（用户重新选了文字但还没提问时） */
  function renderCompose(preset = "") {
    $("#ask-input").value = preset;
    const body = $("#ask-body");
    if (!body.querySelector(".ask-turn")) {
      body.innerHTML = `<p class="hint ask-empty-hint">选中对话里的任意文字，
        点「💬 就此提问」；回答会追问式追加在这里，不会打断主对话。</p>`;
    }
    // 待提问引文条：让你看清这次选中的是哪段
    const pending = $("#ask-pending");
    if (state.sourceText) {
      pending.hidden = false;
      pending.innerHTML = `<span class="p-label">将引用</span>
        <span class="p-text">${esc(state.sourceText.slice(0, 90))}${
          state.sourceText.length > 90 ? "…" : ""}</span>
        <button class="p-clear" title="取消引用">✕</button>`;
      pending.querySelector(".p-clear").onclick = () => {
        state.sourceText = "";
        state.messageId = null;
        pending.hidden = true;
      };
    } else {
      pending.hidden = true;
      pending.innerHTML = "";
    }
  }

  function renderHome() {
    const items = state.history;
    if (!items.length) {
      $("#ask-body").innerHTML = `<p class="hint ask-empty-hint">选中对话里的任意文字，
        点「💬 就此提问」；回答会追加在这里，不会打断主对话。</p>`;
      return;
    }
    $("#ask-body").innerHTML = items.map((s) => `
      <div class="ask-history-item" data-id="${s.id}">
        <div class="qq">${esc(s.question)}</div>
        <div class="aa">${esc((s.answer || "（无回答）").slice(0, 220))}</div>
      </div>`).join("");
    $("#ask-body").querySelectorAll(".ask-history-item").forEach((el) => {
      el.onclick = () => {
        const s = items.find((x) => x.id === el.dataset.id);
        if (!s) return;
        state.sourceText = s.source_text;
        state.messageId = s.message_id;
        state.lastQuestion = s.question;
        state.lastAnswer = s.answer || "";
        $("#ask-title").textContent = "提问记录";
        renderCompose();
        $("#ask-stream").innerHTML =
          `<div class="ask-q">${esc(s.question)}</div>
           <div class="ask-a md">${MD.render(s.answer || "")}</div>`;
      };
    });
  }

  async function submit() {
    const q = $("#ask-input").value.trim();
    if (state.streaming) return;
    if (!q) return toast("先输入问题");
    if (!state.sourceText) return toast("先选中要提问的文字");

    const provider = currentProvider?.();
    if (provider && !provider.configured) {
      return toast("该服务商未配置 API Key，请点右上角 ⚙ 设置");
    }

    // 悬浮提问不需要会话：有会话就走带归档的端点，没有就走全局端点
    const conv = state.activeConv;
    const endpoint = conv
      ? `/api/conversations/${conv.id}/ask`
      : "/api/ask";

    state.streaming = true;
    state.lastQuestion = q;
    state.lastAnswer = "";
    $("#ask-send").disabled = true;
    $("#ask-input").value = "";

    // 追加一轮（不清空已有对话）
    state.lastQuote = state.sourceText;
    const turn = appendTurn(state.sourceText, q, "");
    const out = turn.querySelector(".ask-a");
    out.classList.add("cursor-blink");
    let text = "";
    let err = "";

    const controller = new AbortController();
    state.abort = controller;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          source_text: state.sourceText,
          question: q,
          message_id: state.messageId,
          provider: composerState?.provider,
          model: composerState?.model,
          effort: composerState?.effort,
        }),
      });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("event-stream")) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `请求失败 (HTTP ${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let evt;
            try { evt = JSON.parse(raw); } catch { continue; }
            if (evt.type === "text") {
              text += evt.text;
              state.lastAnswer = text;
              out.innerHTML = MD.render(text);
              const body = $("#ask-body");
              body.scrollTop = body.scrollHeight;
            }
            if (evt.type === "error") err = evt.message;
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") err = e.message;
    } finally {
      state.streaming = false;
      state.abort = null;
      $("#ask-send").disabled = false;
      out.classList.remove("cursor-blink");
      if (err) {
        out.innerHTML += `<div class="test-result bad" style="margin-top:8px">✗ ${esc(err)}</div>`;
      } else if (!text) {
        out.innerHTML = '<span class="hint">（无回答）</span>';
      }
      await loadHistory();
      // 本轮已用掉这段引文；下次选词会重新设置
      state.sourceText = "";
      state.messageId = null;
      renderCompose();
    }
  }

  async function loadHistory() {
    const conv = state.activeConv;
    if (!conv) return;
    state.history = await api(`/api/conversations/${conv.id}/snippets`).catch(() => []);
  }

  function openHistory() {
    const panel = ensurePanel();
    panel.classList.add("open");
    state.open = true;
    if (!state.activeConv) {
      $("#ask-title").textContent = "提问记录";
      $("#ask-body").innerHTML = `<p class="hint ask-empty-hint">
        提问记录按会话归档；当前没有打开任何会话。
        直接选中文字提问即可，不选会话也能用。</p>`;
      return;
    }
    loadHistory().then(renderHome);
  }

  function close() {
    const panel = $("#ask-panel");
    if (panel) panel.classList.remove("open");
    state.open = false;
  }

  function reset(convId) {
    if (state.convId !== convId) {
      state.history = [];
      state.sourceText = "";
      state.messageId = null;
    }
    state.convId = convId;
  }

  return { bindSelection, openWith, openHistory, close, reset, loadHistory };
})();

/* ---------------------------------------------------------------- 画板 */
const Board = (() => {
  "use strict";

  const state = {
    boards: [],
    board: null,
    linkMode: false,
    linkFrom: null,
    selected: null,
    dragging: null,
    dirty: false,
  };

  const NODE_W = 232;
  const NODE_H = 130;   // 估算高度，用于连线锚点

  /* ---- 视图记忆（对应 doc/feat/board-as-view.md §2.3） ----
     chattool.view         当前一级视图 chat / board
     chattool.board.open   已打开的画板 id（有序，去重）
     chattool.board.active 上次用的画板（决定「＋ 画板」直接进哪里） */
  const K_VIEW = "chattool.view";
  const K_ACTIVE = "chattool.board.active";

  function readLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch { return fallback; }
  }
  function writeLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 隐私模式忽略 */ }
  }
  function activeBoardId() {
    const v = readLS(K_ACTIVE, null);
    return typeof v === "string" ? v : null;
  }
  function setActiveBoardId(id) { writeLS(K_ACTIVE, id || null); }

  /* 画板 SVG 用内联颜色（SVG 属性无法写 var()），
     所以从 CSS 变量里读出当前主题的色值，换肤后重绘即生效 */
  function skin() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
    return {
      accent: v("--acc", "#6b8afd"),
      edge: v("--edge", "#5b6b8f"),
      port: v("--port", "#5b6b8f"),
      labelBg: v("--edge-label-bg", "#171a23"),
      labelLine: v("--edge-label-line", "#2b3243"),
    };
  }

  /* ---- 统一 tab 模型：对话与画板共用一套 ----
     chattool.tabs        [{kind:"chat"|"board", id}] 有序、去重
     chattool.tab.active  {kind, id} 当前项
     真身在 localStorage，这里用一个内存缓存减少 JSON 解析。 */
  const K_TABS = "chattool.tabs";
  const K_TAB_ACTIVE = "chattool.tab.active";

  function readTabs() {
    const v = readLS(K_TABS, []);
    if (!Array.isArray(v)) return [];
    return v.filter((t) => t && typeof t.id === "string"
      && (t.kind === "chat" || t.kind === "board"));
  }
  function writeTabs(list) {
    // 去重：同一 kind+id 只留最后一次
    const seen = new Set();
    const out = [];
    for (const t of list) {
      const k = `${t.kind}:${t.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ kind: t.kind, id: t.id });
    }
    writeLS(K_TABS, out);
    return out;
  }
  function activeTab() {
    const v = readLS(K_TAB_ACTIVE, null);
    if (!v || typeof v.id !== "string") return null;
    return { kind: v.kind === "board" ? "board" : "chat", id: v.id };
  }
  function setActiveTab(kind, id) { writeLS(K_TAB_ACTIVE, { kind, id }); }

  /* 当前会话 id（从 app.js 的全局状态取，避免被本闭包的 state 遮蔽） */
  function chatId() {
    try {
      const s = window.__chattoolAppState;
      return (s && s.activeConv && s.activeConv.id) || null;
    } catch { return null; }
  }
  function chatTitle(id) {
    try {
      const s = window.__chattoolAppState;
      if (!s) return "对话";
      if (s.activeConv && s.activeConv.id === id) return s.activeConv.title || "对话";
      const c = (s.convs || []).find((x) => x.id === id);
      return (c && c.title) || "对话";
    } catch { return "对话"; }
  }

  /* 滚动位置记忆：只存内存（跨刷新不保留，避免“一打开就在中间”的怪异感） */
  const scrollMemo = new Map();

  /** 切走前记下阅读位置：优先用最靠上的可见消息作锚点 */
  function saveScroll(convId) {
    if (!convId) return;
    const detail = $("#detail");
    if (!detail) return;
    let anchorId = null;
    let best = Infinity;
    document.querySelectorAll(".msg[data-id]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.top - (detail.getBoundingClientRect().top + 8));
      if (r.bottom > 0 && d < best) { best = d; anchorId = el.dataset.id; }
    });
    scrollMemo.set(convId, { top: detail.scrollTop, anchorId });
  }

  /** 切回来时恢复：锚点消息优先（消息高度会因图片/表格变化，纯像素会飘） */
  function restoreScroll(convId) {
    const memo = scrollMemo.get(convId);
    const detail = $("#detail");
    if (!memo || !detail) return false;
    if (memo.anchorId) {
      const el = document.querySelector(`.msg[data-id="${memo.anchorId}"]`);
      if (el) {
        el.scrollIntoView({ block: "start" });
        // scrollIntoView 可能把标题栏也推走，退一点更自然
        detail.scrollTop = Math.max(0, detail.scrollTop - 8);
        return true;
      }
    }
    detail.scrollTop = memo.top || 0;
    return true;
  }

  /** 重绘顶部 tab（对话 + 画板共用） */
  function renderTabs() {
    const box = $("#vtab-list");
    const bv = $("#boardview");
    const curView = bv && !bv.hidden ? "board" : "chat";
    const curId = curView === "board" ? (state.board?.id || activeBoardId()) : chatId();

    if (!box) return;
    const boards = Object.fromEntries((state.boards || []).map((b) => [b.id, b]));
    const chats = Object.fromEntries(((window.__chattoolAppState?.convs) || [])
      .map((c) => [c.id, c]));
    const activeChat = window.__chattoolAppState?.activeConv;

    // 剔除已失效的 tab：画板被删 / 会话被删
    const alive = readTabs().filter((t) => {
      if (t.kind === "board") return !!boards[t.id];
      return !!chats[t.id] || (activeChat && activeChat.id === t.id);
    });
    if (alive.length !== readTabs().length) writeTabs(alive);

    box.innerHTML = alive.map((t) => {
      const on = curView === t.kind && curId === t.id;
      const raw = t.kind === "board"
        ? ((boards[t.id] && boards[t.id].name) || "画板")
        : chatTitle(t.id);
      const title = raw.length > 14 ? raw.slice(0, 14) + "…" : raw;
      const icon = t.kind === "board" ? "🎨" : "💬";
      return `<div class="vtab ${on ? "active" : ""}"
                   data-tab-kind="${t.kind}" data-tab-id="${t.id}">
          <span class="t">${icon} ${esc(title)}</span>
          <button class="x" data-closetab="1" title="关闭">✕</button>
        </div>`;
    }).join("");

    box.querySelectorAll("[data-tab-kind]").forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest("[data-closetab]")) return;
        activateTab(el.dataset.tabKind, el.dataset.tabId);
      };
    });
    box.querySelectorAll("[data-closetab]").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const host = btn.closest("[data-tab-kind]");
        if (host) closeTab(host.dataset.tabKind, host.dataset.tabId);
      };
    });
  }

  /** 激活任一种 tab */
  async function activateTab(kind, id) {
    if (kind === "board") return switchMainView("board", id);
    return switchMainView("chat", id);
  }

  /** 会话标题（兼容旧调用）。
   *  ⚠️ 本闭包内的 state 会遮蔽 app.js 的全局 state，必须走显式引用。 */
  function convTitle() {
    try {
      const s = window.__chattoolAppState;
      return (s && s.activeConv && s.activeConv.title) || "";
    } catch { return ""; }
  }

  /** 一级视图切换：chat 时可指定具体会话 id */
  async function switchMainView(view, idArg) {
    const bv = $("#boardview");
    const detail = $("#detail");
    if (!bv || !detail) return;

    if (view === "chat") {
      const target = idArg || chatId();
      const prev = chatId();
      // 切走前先记住当前会话的阅读位置
      if (prev && prev !== target) saveScroll(prev);

      bv.hidden = true;
      bv.classList.remove("fullscreen");
      detail.hidden = false;
      writeLS(K_VIEW, "chat");

      if (target) {
        writeTabs([...readTabs(), { kind: "chat", id: target }]);
        setActiveTab("chat", target);
        if (prev !== target) {
          try { await openConv(target); } catch { /* 会话可能已被删 */ }
        }
        // openConv 重渲染了消息，渲染完再恢复位置
        restoreScroll(target);
      }
      renderTabs();
      return;
    }

    const id = idArg || activeBoardId();
    if (!id) { switchMainView("chat"); return; }

    // 从会话切到画板，也要记住会话位置
    const prevChat = chatId();
    if (prevChat) saveScroll(prevChat);

    detail.hidden = true;
    bv.hidden = false;
    writeLS(K_VIEW, "board");
    writeTabs([...readTabs(), { kind: "board", id }]);
    setActiveTab("board", id);
    setActiveBoardId(id);
    await loadBoards({ applyActive: false });
    await loadBoard(id).catch(() => {});
    if ($("#board-select")) $("#board-select").value = id;
    renderTabs();
  }

  /** 打开一个会话 tab（不重复） */
  async function openChatTab(id) {
    writeTabs([...readTabs(), { kind: "chat", id }]);
    await switchMainView("chat", id);
  }

  /** 「＋」弹窗：同时列出会话与画板，选哪个开哪个 tab。
   *
   * 为什么不直接复用 pickBoard：那个是「把内容加入画板」的选择器，
   * 语义是“目标画板”；这里的语义是“打开一个视图”，且还要列出会话。
   * 两者共用一个弹窗 DOM，但入口与标题不同，避免用户误以为在选导出目标。
   */
  function openTabPicker() {
    const modal = $("#modal-pick-board");
    const list = $("#pick-board-list");
    if (!modal || !list) return;

    const convs = ((window.__chattoolAppState?.convs) || []).slice(0, 30);
    const boards = state.boards || [];
    const openSet = new Set(readTabs().map((t) => `${t.kind}:${t.id}`));

    const item = (kind, id, name, meta) => {
      const already = openSet.has(`${kind}:${id}`);
      return `<button class="pick-board-item" data-kind="${kind}" data-id="${id}">
          <span class="n">${kind === "board" ? "🎨 " : "💬 "}${esc(name)}</span>
          <span class="c">${already ? "已打开" : esc(meta)}</span>
        </button>`;
    };

    list.innerHTML =
      (boards.length
        ? `<div class="pick-sec">画板</div>`
          + boards.map((b) => item("board", b.id, b.name, `${b.node_count || 0} 节点`)).join("")
        : "")
      + (convs.length
        ? `<div class="pick-sec">会话</div>`
          + convs.map((c) => item("chat", c.id, c.title, `${c.message_count || 0} 条`)).join("")
        : "")
      || `<p class="hint">还没有会话或画板。</p>`;

    const h3 = modal.querySelector("h3");
    if (h3) h3.textContent = "打开会话或画板";
    // 这个入口不需要“新建画板”那块，隐藏掉，保持简洁
    const newBox = modal.querySelector(".pick-board-new");
    if (newBox) newBox.hidden = true;
    $("#pick-board-name").value = "";
    modal.hidden = false;

    const finish = () => { modal.hidden = true; };
    modal.onclick = (e) => { if (e.target === modal) finish(); };
    $("#pick-board-cancel").onclick = finish;

    list.onclick = async (e) => {
      const b = e.target.closest(".pick-board-item");
      if (!b) return;
      finish();
      if (b.dataset.kind === "board") await openBoardTab(b.dataset.id);
      else await openChatTab(b.dataset.id);
    };
  }

  /** 打开一个画板 tab（不重复） */
  async function openBoardTab(id) {
    writeTabs([...readTabs(), { kind: "board", id }]);
    await switchMainView("board", id);
  }

  /** 关闭任一种 tab：关的是当前项才切走，回落到相邻项 */
  async function closeTab(kind, id) {
    const tabs = readTabs();
    const idx = tabs.findIndex((t) => t.kind === kind && t.id === id);
    const rest = tabs.filter((t) => !(t.kind === kind && t.id === id));
    writeTabs(rest);

    const act = activeTab();
    const isCurrent = act && act.kind === kind && act.id === id;
    if (!isCurrent) { renderTabs(); return; }

    const fallback = rest[Math.min(idx < 0 ? 0 : idx, rest.length - 1)] || null;
    if (fallback) {
      await activateTab(fallback.kind, fallback.id);
      return;
    }

    // 没有剩下任何 tab：不能把界面空着
    if (kind === "board") {
      // 关的是最后一个画板 tab → 回到对话（若连对话 tab 也没有就开一个）
      const keep = chatId();
      if (keep) await openChatTab(keep);
      else await switchMainView("chat");
    } else {
      // 关掉最后一个会话 tab → 回原会话，或开一个新的
      const keep = chatId();
      if (keep && keep !== id) {
        await openChatTab(keep);
      } else if (typeof ensureConversation === "function") {
        // 让 app.js 决定开哪个（复用“永不空白”的契约）
        try {
          window.__chattoolAppState.activeConv = null;
          await ensureConversation();
        } catch { /* 离线等情况：下面统一兜底 */ }
        const nid = chatId();
        if (nid) await openChatTab(nid);
      }
    }
    // 兜底：若最终没有可用的当前项，清掉 active，避免刷新后恢复出一个已关闭的 tab
    const finalAct = activeTab();
    if (finalAct && !readTabs().some((t) => t.kind === finalAct.kind && t.id === finalAct.id)) {
      writeLS(K_TAB_ACTIVE, null);
    }
    renderTabs();
  }

  /** 兼容旧调用：按画板 id 关 */
  async function closeBoardTab(id) { return closeTab("board", id); }

  async function open() {
    // 打开画板视图（默认进入上次用的画板）；一个画板都没有就建一个
    const id = activeBoardId() || state.boards[0]?.id;
    if (!id) {
      const b = await api("/api/boards", { method: "POST", body: { name: "新画板" } });
      await loadBoards();
      return openBoardTab(b.id);
    }
    return openBoardTab(id);
  }

  function close() {
    if (state.dirty) loadConvListQuietly();
    return switchMainView("chat");
  }

  /** 全屏开关（可选增强，不改变“画板是视图”的语义） */
  function toggleFullscreen() {
    const bv = $("#boardview");
    if (!bv) return;
    bv.classList.toggle("fullscreen");
    $("#btn-board-full")?.classList.toggle("on", bv.classList.contains("fullscreen"));
  }

  async function loadBoards({ applyActive = true } = {}) {
    state.boards = await api("/api/boards");
    const sel = $("#board-select");
    if (sel) {
      sel.innerHTML = state.boards.map((b) =>
        `<option value="${b.id}">${esc(b.name)}（${b.node_count}）</option>`).join("");
    }
    if (!state.boards.length) {
      state.board = null;
      setActiveBoardId(null);
      renderCanvas();
      renderTabs();
      renderSidebarList();
      return null;
    }
    // 优先保持当前画板 → 其次上次用的 → 最后才回第一块
    const cur = state.board && state.boards.find((b) => b.id === state.board.id);
    const remembered = state.boards.find((b) => b.id === activeBoardId());
    const targetId = (cur || remembered || state.boards[0]).id;
    if (sel) sel.value = targetId;
    // applyActive=false：只刷新清单，不改变「当前画板」
    // （切换视图时会显式 loadBoard(id)，不能被这里覆盖回去）
    if (applyActive && !state.board) setActiveBoardId(targetId);
    renderSidebarList();
    return targetId;
  }

  async function loadBoard(id) {
    state.board = await api(`/api/boards/${id}`);
    state.selected = null;
    state.linkFrom = null;
    setActiveBoardId(id);   // 记住当前画板（下次打开直接回来）
    $("#board-name").value = state.board.name || "";
    renderCanvas();
    renderTabs();
    renderSidebarList();
  }

  async function createBoard() {
    const name = prompt("画板名称", "新画板");
    if (!name) return;
    const b = await api("/api/boards", { method: "POST", body: { name } });
    await loadBoards();
    $("#board-select").value = b.id;
    await loadBoard(b.id);
  }

  function renderCanvas() {
    const nodesBox = $("#board-nodes");
    const svg = $("#board-svg");
    const empty = $("#board-empty");
    if (!state.board) {
      nodesBox.innerHTML = "";
      svg.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML = `<p>还没有画板。</p>
        <p class="hint">点上方「＋ 新建」，然后在消息底部用「＋ 画板」加入内容。</p>`;
      return;
    }
    const nodes = state.board.nodes || [];
    empty.hidden = nodes.length > 0;

    nodesBox.innerHTML = nodes.map((n) => {
      // 0 = 未手动调整，交给 CSS 默认值；否则用存下的尺寸
      const size = [
        n.w > 0 ? `width:${n.w}px` : "",
        n.h > 0 ? `height:${n.h}px` : "",
      ].filter(Boolean).join(";");
      return `
      <div class="bnode ${state.selected === n.id ? "selected" : ""} ${n.h > 0 ? "sized" : ""}"
           data-id="${n.id}"
           style="left:${n.x}px;top:${n.y}px;border-left-color:${n.color};${size}">
        <div class="bnode-meta">
          <span>${roleIcon(n.role)}</span>
          <span class="src">${esc(n.conv_title
            || (n.role === "note" ? "自由文本" : "手动节点"))}</span>
          ${n.missing ? '<span title="原消息已删除">⚠</span>' : ""}
        </div>
        <div class="bnode-note" contenteditable="true"
             data-id="${n.id}">${esc(n.note)}</div>
        <div class="bnode-text md">${n.content
          ? MD.render(n.content)
          : '<span class="hint">（内容不可用）</span>'}</div>
        <div class="bnode-tools">
          <button data-act="open" data-id="${n.id}" data-conv="${n.conv_id || ""}">查看原文</button>
          <button data-act="color" data-id="${n.id}">颜色</button>
          <button data-act="remove" data-id="${n.id}">移出</button>
        </div>
        <div class="bnode-resize" title="拖动调整卡片大小（双击恢复默认）"></div>
        <div class="bnode-port" title="从这里拖到另一个节点，建立关系"></div>
      </div>`;
    }).join("");

    bindNodes();
    renderEdges();
    updateHint();
  }

  /* 预设色板：与文件夹 chip 用同一套色，视觉统一。
     旧实现是「循环切到下一个色」，用户得点好几次才知道有没有想要的——
     这里直接列出全部，点哪个是哪个。 */
  const NODE_COLORS = [
    { v: "#6b8afd", name: "蓝" },
    { v: "#37c98b", name: "绿" },
    { v: "#e8c15a", name: "黄" },
    { v: "#e2606b", name: "红" },
    { v: "#b57ce0", name: "紫" },
  ];

  function openPalette(anchor, nodeId) {
    let pop = $("#bnode-palette");
    if (!pop) {
      pop = document.createElement("div");
      pop.id = "bnode-palette";
      pop.className = "bnode-palette";
      document.body.appendChild(pop);
    }
    const cur = state.board?.nodes?.find((n) => n.id === nodeId)?.color;
    pop.innerHTML = NODE_COLORS.map((c) =>
      `<button class="sw ${c.v === cur ? "on" : ""}" data-color="${c.v}"
               title="${c.name}" style="background:${c.v}"></button>`).join("");

    const r = anchor.getBoundingClientRect();
    pop.hidden = false;
    pop.style.position = "fixed";
    const w = pop.offsetWidth || 150;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    pop.style.top = `${Math.max(8, r.top - (pop.offsetHeight || 36) - 6)}px`;

    pop.onclick = async (e) => {
      const b = e.target.closest("[data-color]");
      if (!b) return;
      await api(`/api/board-nodes/${nodeId}`,
        { method: "PATCH", body: { color: b.dataset.color } });
      pop.hidden = true;
      await loadBoard(state.board.id);
    };
    if (!pop.dataset.bound) {
      pop.dataset.bound = "1";
      document.addEventListener("click", (e) => {
        if (!pop.hidden && !pop.contains(e.target)
            && !e.target.closest('[data-act="color"]')) pop.hidden = true;
      });
    }
  }

  /* ---- 侧栏画板列表：与「会话」一致的组织方式 ---- */
  function renderSidebarList() {
    const box = $("#board-list");
    if (!box) return;
    const kw = ($("#global-search")?.value || "").trim().toLowerCase();
    const list = (state.boards || []).filter(
      (b) => !kw || (b.name || "").toLowerCase().includes(kw));
    if (!list.length) {
      box.innerHTML = `<p class="hint">${kw
        ? "没有匹配的画板。"
        : "还没有画板。点上方「＋ 新建」创建，或在消息里点「＋ 画板」把内容搬进来。"}</p>`;
      return;
    }
    const cur = state.board?.id;
    box.innerHTML = list.map((b) => {
      const chips = (b.folders || []).map((f) =>
        `<span class="chip"><i class="dot" style="background:${f.color}"></i>${esc(f.name)}</span>`
      ).join("");
      return `<div class="board-item ${cur === b.id ? "active" : ""}" data-id="${b.id}">
          <div class="board-row">
            <div class="t">🎨 ${esc(b.name)}</div>
            <button class="conv-more-btn" data-board-menu="${b.id}"
                    title="重命名 / 归类" aria-label="画板操作">⋯</button>
          </div>
          <div class="meta">
            <span>${b.node_count || 0} 节点</span>
            <span>${b.edge_count || 0} 关系</span>
            ${chips}
          </div>
        </div>`;
    }).join("");

    box.querySelectorAll(".board-item").forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest("[data-board-menu]")) return;
        openBoardTab(el.dataset.id);
      };
    });
    box.querySelectorAll("[data-board-menu]").forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); showBoardMenu(btn.dataset.boardMenu); };
    });
  }

  /** 画板操作：重命名 / 归类到文件夹 */
  function showBoardMenu(boardId) {
    const b = (state.boards || []).find((x) => x.id === boardId);
    if (!b) return;
    openBoardFolderPicker(b);
  }

  /** 把画板归类到文件夹（复用会话那套概念，多对多） */
  async function openBoardFolderPicker(board) {
    const modal = $("#modal-folders");
    if (!modal) return;
    let all = [];
    try { all = await api("/api/folders"); } catch { /* 离线 */ }
    const cur = new Set((board.folders || []).map((f) => f.id));
    $("#modal-folder-list").innerHTML = all.length
      ? all.map((f) => `
          <label><input type="checkbox" value="${f.id}" ${cur.has(f.id) ? "checked" : ""}>
            <i class="dot" style="background:${f.color}"></i>${esc(f.name)}
            <span class="cnt" style="margin-left:auto;color:var(--dim);font-size:11px">${f.total ?? 0}</span>
          </label>`).join("")
        + `<p class="hint">画板可同时归入多个文件夹，与会话一致。</p>`
      : `<p class="hint">还没有文件夹，先到侧栏「文件夹」标签创建。</p>`;

    const h3 = modal.querySelector("h3");
    if (h3) h3.textContent = `归类画板「${board.name}」`;
    modal.hidden = false;

    const foot = modal.querySelector(".modal-foot");
    foot.innerHTML = "";
    const close = document.createElement("button");
    close.className = "btn ghost";
    close.textContent = "关闭";
    close.onclick = () => (modal.hidden = true);
    const save = document.createElement("button");
    save.className = "btn primary";
    save.textContent = "保存";
    save.onclick = async () => {
      const ids = [...modal.querySelectorAll("#modal-folder-list input:checked")]
        .map((i) => i.value);
      await api(`/api/boards/${board.id}/folders`,
        { method: "PUT", body: { folder_ids: ids } });
      modal.hidden = true;
      await loadBoards();
      toast("已更新归类");
    };
    foot.append(close, save);
  }

  function roleIcon(role) {
    return { user: "👤", assistant: "🤖", system: "⚙️", tool: "🔧" }[role] || "📌";
  }

  function updateHint() {
    const hint = $("#board-hint");
    if (!state.board) { hint.textContent = ""; return; }
    const n = state.board.nodes?.length || 0;
    const e = state.board.edges?.length || 0;
    if (state.linkMode) {
      hint.textContent = state.linkFrom
        ? "再点一个节点完成连线（Esc 取消）"
        : "点选模式：依次点起点和终点（也可直接拖节点右侧圆点）";
    } else {
      hint.textContent = `${n} 个节点 · ${e} 条关系｜拖右侧圆点到另一节点可连线`;
    }
    $("#btn-board-link").classList.toggle("on", state.linkMode);
  }

  function bindNodes() {
    const box = $("#board-nodes");
    box.querySelectorAll(".bnode").forEach((el) => {
      const id = el.dataset.id;
      const node = () => state.board.nodes.find((n) => n.id === id);

      /* ---------- 拖动移动 ---------- */
      el.addEventListener("pointerdown", (e) => {
        // 编辑备注、点工具按钮、拉连接点、拖尺寸时不触发移动
        if (e.target.closest(".bnode-tools")) return;
        if (e.target.closest(".bnode-port")) return;
        if (e.target.closest(".bnode-resize")) return;
        if (e.target.isContentEditable) return;
        if (state.linkMode) return;
        if (!node()) return;
        e.preventDefault();

        const d = {
          id,
          startX: e.clientX,
          startY: e.clientY,
          origX: node().x,
          origY: node().y,
          moved: false,
        };
        state.dragging = d;
        el.classList.add("dragging");
        try { el.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }

        // 监听绑在 document 上：即使元素重渲染也不会丢事件
        const onMove = (ev) => {
          if (state.dragging !== d) return;
          const dx = ev.clientX - d.startX;
          const dy = ev.clientY - d.startY;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          const n = node();
          if (!n) return;
          n.x = Math.max(0, d.origX + dx);
          n.y = Math.max(0, d.origY + dy);
          el.style.left = `${n.x}px`;
          el.style.top = `${n.y}px`;
          renderEdges();
        };

        const onUp = async () => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          el.classList.remove("dragging");
          if (state.dragging === d) state.dragging = null;

          const n = node();
          if (!n) return;
          if (!d.moved) {
            // 没移动 = 点击选中
            state.selected = state.selected === id ? null : id;
            renderCanvas();
            return;
          }
          try {
            await api(`/api/board-nodes/${id}`,
              { method: "PATCH", body: { x: n.x, y: n.y } });
          } catch (err) {
            toast("保存位置失败：" + err.message);
          }
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      });

      /* ---------- 拖动右下角调整卡片尺寸 ---------- */
      const resizeEl = el.querySelector(".bnode-resize");
      if (resizeEl) {
        resizeEl.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();   // 不能冒泡到移动逻辑，否则拖尺寸会同时挪位置
          const n = node();
          if (!n) return;
          const d = {
            id,
            startX: e.clientX,
            startY: e.clientY,
            origW: n.w > 0 ? n.w : el.offsetWidth,
            origH: n.h > 0 ? n.h : el.offsetHeight,
          };
          el.classList.add("resizing");
          try { resizeEl.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }

          const onMove = (ev) => {
            const n2 = node();
            if (!n2) return;
            // 下限与后端的钳制保持一致，避免拖出负尺寸
            n2.w = Math.max(120, Math.min(900, d.origW + ev.clientX - d.startX));
            n2.h = Math.max(60, Math.min(1200, d.origH + ev.clientY - d.startY));
            el.style.width = `${n2.w}px`;
            el.style.height = `${n2.h}px`;
            el.classList.add("sized");
            renderEdges();   // 连线端点跟着卡片边缘走
          };

          const onUp = async () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            el.classList.remove("resizing");
            const n2 = node();
            if (!n2) return;
            try {
              await api(`/api/board-nodes/${id}`,
                { method: "PATCH", body: { w: n2.w, h: n2.h } });
            } catch (err) {
              toast("保存尺寸失败：" + err.message);
            }
          };

          document.addEventListener("pointermove", onMove);
          document.addEventListener("pointerup", onUp);
        });

        // 双击恢复默认尺寸
        resizeEl.addEventListener("dblclick", async (e) => {
          e.stopPropagation();
          const n = node();
          if (!n) return;
          n.w = 0;
          n.h = 0;
          el.style.width = "";
          el.style.height = "";
          el.classList.remove("sized");
          renderEdges();
          await api(`/api/board-nodes/${id}`, { method: "PATCH", body: { w: 0, h: 0 } });
          toast("已恢复默认大小");
        });
      }

      /* ---------- 已存节点的备注编辑 ---------- */
      const noteEl = el.querySelector(".bnode-note");
      if (noteEl) {
        noteEl.addEventListener("blur", async () => {
          const text = noteEl.textContent.trim();
          const n = node();
          if (n && n.note !== text) {
            await api(`/api/board-nodes/${id}`, { method: "PATCH", body: { note: text } });
            n.note = text;
          }
        });
        noteEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); noteEl.blur(); }
        });
      }

      /* ---------- 工具按钮 ---------- */
      el.querySelector(".bnode-tools")?.addEventListener("click", async (e) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "remove") {
          await api(`/api/board-nodes/${id}`, { method: "DELETE" });
          await loadBoard(state.board.id);
        }
        if (act === "open") {
          const convId = btn.dataset.conv;
          if (!convId) return toast("这是一个自由文本节点");
          close();
          await openConv(convId);
        }
        if (act === "color") {
          openPalette(btn, id);
        }
      });

      /* ---------- 连接点：从这里拖出一条线 ---------- */
      el.querySelector(".bnode-port")?.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startWire(id, e);
      });
    });
  }

  /** 从 A 拖到 B 画一条线（直接拖拽，无需先开连线模式） */
  function startWire(fromId, ev) {
    const svg = $("#board-svg");
    const from = state.board.nodes.find((n) => n.id === fromId);
    if (!from) return;

    const canvas = $("#board-canvas");
    const rect = canvas.getBoundingClientRect();
    const toCanvas = (cx, cy) => ({
      x: cx - rect.left + canvas.scrollLeft,
      y: cy - rect.top + canvas.scrollTop,
    });

    // 起点用连接点的实际位置，节点高度变化也能对准
    const portEl = document.querySelector(`.bnode[data-id="${fromId}"] .bnode-port`);
    const portRect = portEl?.getBoundingClientRect();
    const p0 = portRect
      ? toCanvas(portRect.left + portRect.width / 2, portRect.top + portRect.height / 2)
      : { x: from.x + NODE_W, y: from.y + 24 };
    const ghost = document.createElementNS("http://www.w3.org/2000/svg", "path");
    ghost.setAttribute("stroke", skin().accent);
    ghost.setAttribute("stroke-width", "2");
    ghost.setAttribute("stroke-dasharray", "5 4");
    ghost.setAttribute("fill", "none");
    svg.appendChild(ghost);

    let hoverId = null;
    const onMove = (e) => {
      const p = toCanvas(e.clientX, e.clientY);
      ghost.setAttribute("d", `M ${p0.x} ${p0.y} C ${p0.x + 50} ${p0.y}, `
        + `${p.x - 50} ${p.y}, ${p.x} ${p.y}`);
      // 高亮落点节点
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest(".bnode");
      const id = el?.dataset.id;
      if (hoverId && hoverId !== id) {
        document.querySelector(`.bnode[data-id="${hoverId}"]`)
          ?.classList.remove("wire-target");
      }
      hoverId = id && id !== fromId ? id : null;
      if (hoverId) {
        document.querySelector(`.bnode[data-id="${hoverId}"]`)
          ?.classList.add("wire-target");
      }
    };

    const onUp = async (e) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      ghost.remove();
      if (hoverId) {
        document.querySelector(`.bnode[data-id="${hoverId}"]`)
          ?.classList.remove("wire-target");
      }
      if (!hoverId) return;   // 落在空白处 = 取消

      const label = prompt("这两个节点的关系是什么？（如：导致 / 反驳 / 细化 / 前置）", "关联");
      if (label === null) return;
      try {
        await api(`/api/boards/${state.board.id}/edges`, {
          method: "POST",
          body: { from_node: fromId, to_node: hoverId, label: label || "关联" },
        });
        state.dirty = true;
        await loadBoard(state.board.id);
        toast("已连线");
      } catch (err) {
        toast(err.message);
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  async function handleLinkClick(nodeId) {
    if (!state.linkFrom) {
      state.linkFrom = nodeId;
      toast("已选起点，再点终点");
      updateHint();
      return;
    }
    if (state.linkFrom === nodeId) {
      state.linkFrom = null;
      updateHint();
      return;
    }
    const label = prompt("这两点的关系是什么？（如：导致 / 反驳 / 细化 / 前置）", "关联");
    if (label === null) { state.linkFrom = null; updateHint(); return; }
    try {
      await api(`/api/boards/${state.board.id}/edges`, {
        method: "POST",
        body: { from_node: state.linkFrom, to_node: nodeId, label: label || "关联" },
      });
      state.dirty = true;
      state.linkFrom = null;
      await loadBoard(state.board.id);
      toast("已连线");
    } catch (e) {
      toast(e.message);
      state.linkFrom = null;
      updateHint();
    }
  }

  function renderEdges() {
    const svg = $("#board-svg");
    if (!state.board) { svg.innerHTML = ""; return; }
    const byId = Object.fromEntries((state.board.nodes || []).map((n) => [n.id, n]));
    const sk = skin();
    const parts = [];

    // 箭头标记
    parts.push(`<defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="${sk.edge}"/>
      </marker></defs>`);

    for (const e of state.board.edges || []) {
      const a = byId[e.from_node];
      const b = byId[e.to_node];
      if (!a || !b) continue;
      // 从右边缘连到左边缘
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      const dash = e.style === "dashed" ? ' stroke-dasharray="6 4"' : "";
      parts.push(`<path class="edge-hit" d="${d}" data-edge="${e.id}"></path>`);
      parts.push(`<path d="${d}" fill="none" stroke="${sk.edge}" stroke-width="1.6"
        marker-end="url(#arrow)"${dash}></path>`);
      if (e.label) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2 - 6;
        parts.push(`<rect x="${mx - e.label.length * 3.6 - 5}" y="${my - 11}"
          width="${e.label.length * 7.2 + 10}" height="17" rx="8"
          fill="${sk.labelBg}" stroke="${sk.labelLine}"></rect>`);
        parts.push(`<text class="edge-label" x="${mx}" y="${my + 1}"
          text-anchor="middle">${esc(e.label)}</text>`);
      }
    }
    svg.innerHTML = parts.join("");

    // 点击连线可编辑/删除
    svg.querySelectorAll(".edge-hit").forEach((p) => {
      p.addEventListener("click", async () => {
        const eid = p.dataset.edge;
        const edge = state.board.edges.find((x) => x.id === eid);
        if (!edge) return;
        const next = prompt("关系名称（留空则删除连线）", edge.label);
        if (next === null) return;
        if (next.trim() === "") {
          await api(`/api/board-edges/${eid}`, { method: "DELETE" });
        } else {
          await api(`/api/board-edges/${eid}`, { method: "PATCH", body: { label: next } });
        }
        await loadBoard(state.board.id);
      });
    });
  }

  /** 从消息底部按钮调用 */
  /** 选择目标画板：真实弹窗选择（而不是 prompt 输序号）。
   *
   * 旧实现用 `prompt("输入序号")`：手机上 prompt 常被浏览器屏蔽，
   * 而且让用户记序号、数序号，既慢又容易选错。这里改成可点的列表，
   * 并且支持当场新建。只有一个画板时也明确提示进了哪块，不静默塞进去。
   */
  function pickBoard() {
    return new Promise((resolve) => {
      const modal = $("#modal-pick-board");
      const list = $("#pick-board-list");
      const newInput = $("#pick-board-name");
      if (!modal || !list) { resolve(null); return; }

      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        modal.hidden = true;
        modal.onclick = null;
        resolve(val);
      };

      const render = () => {
        const bs = state.boards || [];
        list.innerHTML = bs.length
          ? bs.map((b) => `
              <button class="pick-board-item" data-id="${b.id}">
                <span class="n">${esc(b.name)}</span>
                <span class="c">${b.node_count || 0} 节点</span>
              </button>`).join("")
          : `<p class="hint">还没有画板，在下面输入名称新建一个。</p>`;
      };
      render();
      newInput.value = "";

      list.onclick = (e) => {
        const b = e.target.closest(".pick-board-item");
        if (!b) return;
        finish(b.dataset.id);
      };
      modal.onclick = (e) => { if (e.target === modal) finish(null); };
      $("#pick-board-cancel").onclick = () => finish(null);
      $("#pick-board-ok").onclick = async () => {
        const name = newInput.value.trim();
        if (!name) { finish(null); return; }
        const b = await api("/api/boards", { method: "POST", body: { name } });
        await loadBoards();
        finish(b.id);
      };
      newInput.onkeydown = (e) => { if (e.key === "Enter") $("#pick-board-ok").click(); };
      // Esc 也要正确 resolve，否则 Promise 永远挂着（全局 Esc 只会隐藏 modal）
      modal.onkeydown = (e) => { if (e.key === "Escape") finish(null); };

      modal.hidden = false;
      // 只有一个画板时自动选中它，但仍让用户看到“要进哪里”，可直接回车确认
      if ((state.boards || []).length === 1) {
        list.querySelector(".pick-board-item")?.classList.add("active");
      }
      setTimeout(() => newInput.focus(), 30);
    });
  }

  /** 把节点插入指定/选定画板。
   *
   * 体验修正：以前每次都弹窗，连加 10 条要弹 10 次。
   * 现在优先直接加入「上次用的画板」；只有没记忆时才弹窗。
   * forcePick = true 时强制弹窗（菜单里的「加入其他画板…」）。
   */
  async function _insert(payload, { forcePick = false } = {}) {
    // 先确保画板列表是最新的（可能刚在别处新建过）
    try { await loadBoards(); } catch { /* 离线时沿用现有列表 */ }

    let targetId = null;
    if (!forcePick) {
      const remembered = activeBoardId();
      if (remembered && (state.boards || []).some((b) => b.id === remembered)) {
        targetId = remembered;
      }
    }
    if (!targetId) targetId = await pickBoard();
    if (!targetId) return;

    const res = await api(`/api/boards/${targetId}/nodes`, { method: "POST", body: payload });
    state.dirty = true;
    // 加入后让它出现在 tab 上（统一 tab 模型）
    writeTabs([...readTabs(), { kind: "board", id: targetId }]);
    setActiveBoardId(targetId);
    if (state.board?.id === targetId) await loadBoard(targetId);
    const name = (state.boards || []).find((b) => b.id === targetId)?.name || "画板";
    toast(`已加入「${name}」`, 2200);
    renderTabs();
    return res;
  }

  /** 把一条消息加入画板 */
  async function addMessage(messageId, convId, opts) {
    return _insert({ message_id: messageId, conv_id: convId }, opts);
  }

  /** 把一段自由文本加入画板（不需要任何会话） */
  async function addText(content, note, opts) {
    return _insert({ content, note: note || "" }, opts);
  }

  async function loadConvListQuietly() {
    if (state.dirty) {
      state.dirty = false;
      await loadConvs().catch(() => {});
    }
  }

  function bind() {
    const safe = (sel, ev, fn) => {
      const el = $(sel);
      if (!el) { console.warn(`[ChatTools/board] 找不到 ${sel}`); return; }
      el.addEventListener(ev, fn);
    };

    safe("#btn-board", "click", () => open());
    safe("#btn-board-new", "click", createBoard);
    safe("#btn-board-full", "click", toggleFullscreen);
    // 对话 tab：切回聊天
    // tab 条上的「＋」：可开会话，也可开画板
    safe("#btn-vtab-add", "click", async () => {
      try { await loadBoards(); } catch { /* 离线 */ }
      openTabPicker();
    });

    safe("#btn-board-export", "click", () => {
      if (!state.board) return toast("先选择一个画板");
      const a = document.createElement("a");
      a.href = `/api/boards/${state.board.id}/export`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    safe("#btn-board-link", "click", () => {
      state.linkMode = !state.linkMode;
      state.linkFrom = null;
      $("#board-nodes").querySelectorAll(".bnode")
        .forEach((el) => el.classList.toggle("linkable", state.linkMode));
      updateHint();
    });
    // 下拉切换画板：当打开新 tab 看待
    safe("#board-select", "change", (e) => openBoardTab(e.target.value));
    safe("#board-name", "change", async (e) => {
      if (!state.board) return;
      await api(`/api/boards/${state.board.id}`,
        { method: "PATCH", body: { name: e.target.value } });
      await loadBoards();
      renderTabs();
    });

    document.addEventListener("keydown", (e) => {
      const bv = $("#boardview");
      if (!bv || bv.hidden) return;
      if (e.key === "Escape") {
        if (bv.classList.contains("fullscreen")) { toggleFullscreen(); return; }
        if (state.linkMode && state.linkFrom) {
          state.linkFrom = null;
          updateHint();
        } else if (state.linkMode) {
          state.linkMode = false;
          state.linkFrom = null;
          $("#board-nodes").querySelectorAll(".bnode")
            .forEach((el) => el.classList.remove("linkable"));
          updateHint();
        }
      }
      // F：全屏 / 退出全屏
      if ((e.key === "f" || e.key === "F") && !e.target.isContentEditable
          && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
        e.preventDefault();
        toggleFullscreen();
      }
    });

    // 点击节点空白处取消选中
    $("#board-canvas").addEventListener("click", (e) => {
      if (e.target.id === "board-canvas" || e.target.id === "board-nodes") {
        state.selected = null;
        renderCanvas();
      }
    });
  }

  /** 换肤后重绘连线，让 SVG 里的内联颜色跟上主题 */
  function refresh() {
    if (state.board) renderEdges();
  }

  /** 「＋ 画板」按钮的入口：记忆优先进上次的画板，不每次都弹窗 */
  async function addToActiveBoard(messageId, convId) {
    return _insert({ message_id: messageId, conv_id: convId });
  }

  /** 恢复上次的一级视图（刷新后不丢位置） */
  async function restoreView() {
    try { await loadBoards(); } catch { /* 离线则停 chat */ }
    const view = readLS(K_VIEW, "chat");
    const act = activeTab();
    const boardId = (act && act.kind === "board" ? act.id : null) || activeBoardId();

    if (view === "board" && boardId && (state.boards || []).some((b) => b.id === boardId)) {
      await switchMainView("board", boardId);
    } else if (act && act.kind === "chat" && act.id) {
      // 上次停在某个对话 tab → 恢复它（app.js 已加载该会话时不再重复拉取）
      await switchMainView("chat", act.id);
    } else {
      await switchMainView("chat");
    }
  }

  return {
    bind, open, close, addMessage, addText, addToActiveBoard,
    loadBoards, refresh, renderTabs, switchMainView, openBoardTab,
    openChatTab, closeTab, closeBoardTab, activateTab,
    saveScroll, restoreScroll,
    restoreView, toggleFullscreen, renderSidebarList,
    openBoardFolderPicker,
  };
})();
