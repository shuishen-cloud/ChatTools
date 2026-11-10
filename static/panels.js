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

  async function open() {
    $("#boardview").hidden = false;
    await loadBoards();
  }

  function close() {
    $("#boardview").hidden = true;
    if (state.dirty) loadConvListQuietly();
  }

  async function loadBoards() {
    state.boards = await api("/api/boards");
    const sel = $("#board-select");
    sel.innerHTML = state.boards.map((b) =>
      `<option value="${b.id}">${esc(b.name)}（${b.node_count}）</option>`).join("");
    if (!state.boards.length) {
      state.board = null;
      renderCanvas();
      return;
    }
    const keep = state.board && state.boards.find((b) => b.id === state.board.id);
    const targetId = keep ? state.board.id : state.boards[0].id;
    sel.value = targetId;
    await loadBoard(targetId);
  }

  async function loadBoard(id) {
    state.board = await api(`/api/boards/${id}`);
    state.selected = null;
    state.linkFrom = null;
    $("#board-name").value = state.board.name || "";
    renderCanvas();
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

    nodesBox.innerHTML = nodes.map((n) => `
      <div class="bnode ${state.selected === n.id ? "selected" : ""}"
           data-id="${n.id}" style="left:${n.x}px;top:${n.y}px;border-left-color:${n.color}">
        <div class="bnode-meta">
          <span>${roleIcon(n.role)}</span>
          <span class="src">${esc(n.conv_title
            || (n.role === "note" ? "自由文本" : "手动节点"))}</span>
          ${n.missing ? '<span title="原消息已删除">⚠</span>' : ""}
        </div>
        <div class="bnode-note" contenteditable="true"
             data-id="${n.id}">${esc(n.note)}</div>
        <div class="bnode-text">${esc(n.content || "（内容不可用）")}</div>
        <div class="bnode-tools">
          <button data-act="open" data-id="${n.id}" data-conv="${n.conv_id || ""}">查看原文</button>
          <button data-act="color" data-id="${n.id}">颜色</button>
          <button data-act="remove" data-id="${n.id}">移出</button>
        </div>
        <div class="bnode-port" title="从这里拖到另一个节点，建立关系"></div>
      </div>`).join("");

    bindNodes();
    renderEdges();
    updateHint();
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
        // 编辑备注、点工具按钮、拉连接点时不触发移动
        if (e.target.closest(".bnode-tools")) return;
        if (e.target.closest(".bnode-port")) return;
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
          const colors = ["#6b8afd", "#37c98b", "#e8c15a", "#e2606b", "#b57ce0"];
          const n = node();
          const idx = colors.indexOf(n.color);
          const next = colors[(idx + 1) % colors.length];
          await api(`/api/board-nodes/${id}`, { method: "PATCH", body: { color: next } });
          await loadBoard(state.board.id);
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
  /** 选择目标画板（没有就新建）。返回 board id 或 null。 */
  async function pickBoard() {
    if (!state.boards.length) {
      const name = prompt("还没有画板，先建一个：", "新画板");
      if (!name) return null;
      const b = await api("/api/boards", { method: "POST", body: { name } });
      await loadBoards();
      return b.id;
    }
    if (state.boards.length === 1) {
      return state.board?.id || state.boards[0].id;
    }
    const options = state.boards.map((b, i) => `${i + 1}. ${b.name}`).join("\n");
    const pick = prompt(`加入哪个画板？输入序号：\n${options}`, "1");
    if (!pick) return null;
    const idx = parseInt(pick, 10) - 1;
    if (Number.isNaN(idx) || !state.boards[idx]) {
      toast("序号无效");
      return null;
    }
    return state.boards[idx].id;
  }

  async function _insert(payload) {
    const targetId = await pickBoard();
    if (!targetId) return;
    await api(`/api/boards/${targetId}/nodes`, { method: "POST", body: payload });
    state.dirty = true;
    if (state.board?.id === targetId) await loadBoard(targetId);
    toast("已加入画板，点顶部「画板」查看");
  }

  /** 把一条消息加入画板 */
  async function addMessage(messageId, convId) {
    return _insert({ message_id: messageId, conv_id: convId });
  }

  /** 把一段自由文本加入画板（不需要任何会话） */
  async function addText(content, note) {
    return _insert({ content, note: note || "" });
  }

  async function loadConvListQuietly() {
    if (state.dirty) {
      state.dirty = false;
      await loadConvs().catch(() => {});
    }
  }

  function bind() {
    $("#btn-board").onclick = open;
    $("#btn-board-close").onclick = close;
    $("#btn-board-new").onclick = createBoard;
    $("#btn-board-export").onclick = () => {
      if (!state.board) return toast("先选择一个画板");
      const a = document.createElement("a");
      a.href = `/api/boards/${state.board.id}/export`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    $("#btn-board-link").onclick = () => {
      state.linkMode = !state.linkMode;
      state.linkFrom = null;
      $("#board-nodes").querySelectorAll(".bnode")
        .forEach((el) => el.classList.toggle("linkable", state.linkMode));
      updateHint();
    };
    $("#board-select").onchange = (e) => loadBoard(e.target.value);
    $("#board-name").onchange = async (e) => {
      if (!state.board) return;
      await api(`/api/boards/${state.board.id}`,
        { method: "PATCH", body: { name: e.target.value } });
      await loadBoards();
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("#boardview").hidden === false) {
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

  return { bind, open, close, addMessage, addText, loadBoards, refresh };
})();
