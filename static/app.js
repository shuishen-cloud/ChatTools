/* ChatTool 前端逻辑（无构建步骤，原生 DOM） */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  convs: [],
  folders: [],
  activeConv: null,      // 当前会话详情（含 messages）
  scopeFolder: null,     // 当前筛选的文件夹
  search: "",
  showAllBranches: false,
  editingMsgId: null,
};

/* ---------------------------------------------------------------- API */
/* 启动自检：任何异常都要显式告诉用户，而不是静默白屏 */
function fatal(where, err) {
  console.error("[ChatTool] " + where, err);
  const box = document.getElementById("boot-error");
  if (box) {
    box.hidden = false;
    box.textContent = `启动失败（${where}）：${err && err.message ? err.message : err}`;
  }
}

window.addEventListener("error", (e) => fatal("脚本错误", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => fatal("未处理的 Promise", e.reason));


async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return res;
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "请求失败");
  return data.data;
}

function toast(msg, ms = 1800) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
};

/* ---------------------------------------------------------------- 侧栏：会话 */
async function loadConvs() {
  const params = new URLSearchParams();
  if (state.scopeFolder) params.set("folder", state.scopeFolder);
  if (state.search) params.set("q", state.search);
  state.convs = await api(`/api/conversations?${params}`);
  renderConvs();
  $("#conv-scope").textContent = state.scopeFolder
    ? (state.folders.find((f) => f.id === state.scopeFolder)?.name || "文件夹")
    : state.search ? `搜索：${state.search}` : "全部会话";
  $("#btn-clear-scope").hidden = !state.scopeFolder && !state.search;
}

function renderConvs() {
  const box = $("#conv-list");
  if (!state.convs.length) {
    box.innerHTML = `<p class="hint">还没有会话。点右上角「＋ 新会话」开始。</p>`;
    return;
  }
  box.innerHTML = state.convs.map((c) => `
    <div class="conv-item ${state.activeConv?.id === c.id ? "active" : ""}" data-id="${c.id}">
      <div class="t">${esc(c.title)}</div>
      <div class="p">${esc(c.preview || "（暂无消息）")}</div>
      <div class="meta">
        <span>${fmtTime(c.updated_at)}</span>
        <span>${c.message_count} 条</span>
        ${(c.folders || []).map((f) => `<span class="chip"><i class="dot" style="background:${f.color}"></i>${esc(f.name)}</span>`).join("")}
      </div>
    </div>`).join("");
}

/* ---------------------------------------------------------------- 侧栏：文件夹 */
async function loadFolders() {
  state.folders = await api("/api/folders");
  const tree = await api("/api/folders?tree=1");
  renderFolderTree(tree);
  renderConvFolders();
}

function renderFolderTree(nodes, depth = 0) {
  const box = $("#folder-tree");
  if (depth === 0) box.innerHTML = "";
  if (depth === 0 && !nodes.length) {
    box.innerHTML = `<p class="hint">还没有文件夹。用「＋ 新建」创建，例如「论文研究」「产品设计」。</p>`;
    return;
  }
  const frag = document.createElement("div");
  frag.className = depth === 0 ? "" : "folder-children";
  for (const f of nodes) {
    const node = document.createElement("div");
    node.className = "folder-node" + (state.scopeFolder === f.id ? " active" : "");
    node.innerHTML = `
      <i class="dot" style="background:${f.color}"></i>
      <span class="name">${esc(f.name)}</span>
      <span class="cnt">${f.count}</span>
      <span class="folder-tools">
        <button data-act="rename" title="重命名">✎</button>
        <button data-act="sort" title="按此文件夹查看">☰</button>
        <button data-act="del" title="删除">🗑</button>
      </span>`;
    node.onclick = (e) => {
      const act = e.target.dataset?.act;
      if (act === "rename") return renameFolder(f);
      if (act === "del") return deleteFolder(f);
      state.scopeFolder = state.scopeFolder === f.id ? null : f.id;
      switchView("conversations");
      loadConvs();
      renderFolderTree(state.foldersTreeCache || [], 1);
    };
    frag.appendChild(node);
    if (f.children?.length) {
      const sub = document.createElement("div");
      sub.className = "folder-children";
      sub.innerHTML = f.children.map((c) => `
        <div class="folder-node" data-id="${c.id}">
          <i class="dot" style="background:${c.color}"></i>
          <span class="name">${esc(c.name)}</span><span class="cnt">${c.count}</span>
        </div>`).join("");
      sub.onclick = (e) => {
        const id = e.target.closest(".folder-node")?.dataset.id;
        if (!id) return;
        state.scopeFolder = id;
        switchView("conversations");
        loadConvs();
      };
      frag.appendChild(sub);
    }
  }
  box.appendChild(frag);
  if (depth === 0) state.foldersTreeCache = nodes;
}

function renderConvFolders() {
  const box = $("#conv-folders");
  if (!state.activeConv) return;
  const cur = state.activeConv.folders || [];
  box.innerHTML = cur.map((f) =>
    `<span class="chip"><i class="dot" style="background:${f.color}"></i>${esc(f.name)}</span>`).join("")
    + `<button class="mini" id="btn-edit-folders">✎ 归类</button>`;
  $("#btn-edit-folders").onclick = openFolderPicker;
}

async function newFolder() {
  const name = prompt("文件夹名称");
  if (!name) return;
  await api("/api/folders", { method: "POST", body: { name, color: randColor() } });
  await loadFolders();
  toast("已创建文件夹");
}

async function renameFolder(f) {
  const name = prompt("新的名称", f.name);
  if (!name) return;
  await api(`/api/folders/${f.id}`, { method: "PATCH", body: { name } });
  await loadFolders();
}

async function deleteFolder(f) {
  if (!confirm(`删除文件夹「${f.name}」？（会话本身不会删除）`)) return;
  await api(`/api/folders/${f.id}`, { method: "DELETE" });
  if (state.scopeFolder === f.id) state.scopeFolder = null;
  await loadFolders();
  await loadConvs();
}

const randColor = () => `hsl(${Math.floor(Math.random() * 360)} 62% 60%)`;

/* ---------------------------------------------------------------- 会话详情 */
async function openConv(id) {
  state.activeConv = await api(`/api/conversations/${id}`);
  state.editingMsgId = null;
  state.showAllBranches = false;
  $("#welcome").hidden = (state.activeConv.messages || []).length > 0;
  $("#conv-title").textContent = state.activeConv.title;
  renderConvFolders();
  renderMessages();
  renderConvs();
  // 右侧历史栏
  await ThreadView.load(id).catch(() => {});
  AskPanel.reset(id);
  if (window.innerWidth <= 760) $("#sidebar").classList.remove("open");
}

function ancestryMap(msgs) {
  const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
  const leaves = msgs.filter((m) => !msgs.some((x) => x.parent_id === m.id));
  leaves.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const main = new Set();
  let cur = leaves[0]?.id;
  while (cur) {
    main.add(cur);
    cur = byId[cur]?.parent_id;
  }
  return { main, byId };
}

function renderMessages() {
  const conv = state.activeConv;
  if (!conv) return;
  const msgs = conv.messages || [];
  const { main } = ancestryMap(msgs);
  const box = $("#messages");

  if (!msgs.length) {
    box.innerHTML = `<p class="hint" style="text-align:center;padding:30px">
      空会话。可在下方输入框粘贴对话内容，或导入已有会话。</p>`;
    return;
  }

  box.innerHTML = msgs.map((m) => {
    const inMain = main.has(m.id);
    const dim = !state.showAllBranches && !inMain ? "hidden-branch" : "";
    const faved = m.favorite ? "faved" : "";
    const tags = (m.tags || []).map((t) => `<span class="tag-pill">${esc(t)}</span>`).join("");
    const multi = m.child_count > 1
      ? `<span class="branch-chip">🔀 ${m.child_count} 分支</span>` : "";
    const editing = state.editingMsgId === m.id;
    const meta = m.meta || {};
    const tagBits = [];
    if (meta.model) tagBits.push(esc(meta.model));
    if (meta.effort && meta.effort !== "medium") tagBits.push("思考·" + esc(meta.effort));
    if (meta.status === "error") tagBits.push("⚠ 失败");
    const metaLine = tagBits.length
      ? `<span class="strength-tag">${tagBits.join(" · ")}</span>` : "";
    const thinking = meta.thinking
      ? `<details class="thinking-block"><summary>💭 思考过程</summary>
           <div class="thinking-body">${esc(meta.thinking)}</div></details>` : "";
    const warn = meta.status === "error" && meta.error
      ? `<div class="test-result bad" style="margin-top:8px">✗ ${esc(meta.error)}</div>` : "";
    const body = editing
      ? `<textarea class="edit-area" id="edit-${m.id}">${esc(m.content)}</textarea>
         <div class="msg-foot" style="opacity:1">
           <button class="tool-btn" data-act="save-edit" data-id="${m.id}">保存为分支</button>
           <button class="tool-btn" data-act="cancel-edit">取消</button>
         </div>`
      : `<div class="msg-body md">${m.content ? MD.render(m.content) : (meta.status === "error" ? "" : "…")}</div>`;
    return `
      <div class="msg ${m.role} ${dim} ${faved} ${meta.status === "error" ? "error-msg" : ""}"
           data-id="${m.id}">
        <div class="msg-head">
          <span class="who">${roleName(m.role)}</span>
          <span>${fmtTime(m.created_at)}</span>
          ${m.favorite ? '<span style="color:var(--gold)">⭐</span>' : ""}
          ${metaLine}${tags}${multi}
        </div>
        ${thinking}
        ${body}${warn}
        ${editing ? "" : `<div class="msg-foot">
          <button class="tool-btn ${m.favorite ? "on" : ""}" data-act="fav" data-id="${m.id}">
            ${m.favorite ? "⭐ 已收藏" : "☆ 收藏"}</button>
          <button class="tool-btn" data-act="edit" data-id="${m.id}">✎ 编辑分支</button>
          <button class="tool-btn" data-act="tag" data-id="${m.id}"># 标签</button>
          <button class="tool-btn" data-act="branch" data-id="${m.id}">⌥ 查看分支</button>
          <button class="tool-btn" data-act="ask" data-id="${m.id}">💬 提问</button>
          <button class="tool-btn" data-act="board" data-id="${m.id}">＋ 画板</button>
          ${m.role === "user" ? `<button class="tool-btn" data-act="regen" data-id="${m.id}">↻ 重新生成</button>` : ""}
          <button class="tool-btn" data-act="del" data-id="${m.id}">🗑</button>
        </div>`}
      </div>`;
  }).join("");

  renderBranchBar(msgs, main);
}

function renderBranchBar(msgs, main) {
  const bar = $("#branch-bar");
  const branches = msgs.filter((m) => !main.has(m.id)).length;
  const hasMulti = msgs.some((m) => m.child_count > 1);
  if (!branches && !hasMulti) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `
    <span>当前显示：${state.showAllBranches ? "全部分支（灰色为旁支）" : "主分支"}</span>
    <span>· 旁支消息 ${branches} 条</span>
    <button id="btn-toggle-branches">${state.showAllBranches ? "只看主线" : "显示全部"}</button>`;
  $("#btn-toggle-branches").onclick = () => {
    state.showAllBranches = !state.showAllBranches;
    renderMessages();
  };
}

/** 供右侧历史栏跳转到旁支时调用：强制展开全部分支 */
function revealAllBranches() {
  state.showAllBranches = true;
  renderMessages();
}

const roleName = (r) => ({ user: "👤 用户", assistant: "🤖 助手", system: "⚙️ 系统", tool: "🔧 工具" }[r] || r);

/* ---------------------------------------------------------------- 消息操作 */
async function toggleFav(id) {
  const m = state.activeConv.messages.find((x) => x.id === id);
  if (!m) return;
  await api(`/api/messages/${id}`, { method: "PATCH", body: { favorite: !m.favorite } });
  await openConv(state.activeConv.id);
  loadFavorites();
}

async function saveBranchEdit(id) {
  const text = $(`#edit-${id}`)?.value ?? "";
  const created = await api(`/api/messages/${id}/branch`,
    { method: "POST", body: { content: text } });
  state.editingMsgId = null;
  toast("已创建编辑分支，原消息保留");
  await openConv(state.activeConv.id);
  $(`.msg[data-id="${created.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function addTag(id) {
  const name = prompt("标签名（用于跨会话聚合同主题消息）");
  if (!name) return;
  await api(`/api/messages/${id}/tags`, { method: "POST", body: { name } });
  await openConv(state.activeConv.id);
}

async function showBranches(id) {
  const info = await api(`/api/messages/${id}/siblings`);
  toast(`该节点共 ${info.total} 个分支，当前第 ${info.index} 个`, 2600);
}

async function deleteMsg(id) {
  if (!confirm("删除这条消息及其后续分支？")) return;
  await api(`/api/messages/${id}?cascade=1`, { method: "DELETE" });
  await openConv(state.activeConv.id);
}

/* ---------------------------------------------------------------- 底部：服务商 / 模型 / 思考强度 */
const composerState = {
  options: null,
  provider: null,
  model: null,
  effort: "medium",
  streaming: false,
  abort: null,
};

const PREF_KEY = "chattool.composer";

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch { return {}; }
}
function savePrefs() {
  try {
    const prev = loadPrefs();
    // 按服务商分别记住上次选的模型
    const perProvider = { ...(prev.perProvider || {}) };
    if (composerState.provider && composerState.model) {
      perProvider[composerState.provider] = composerState.model;
    }
    localStorage.setItem(PREF_KEY, JSON.stringify({
      provider: composerState.provider,
      model: composerState.model,
      effort: composerState.effort,
      perProvider,
    }));
  } catch { /* 隐私模式下忽略 */ }
}

async function loadComposerOptions() {
  composerState.options = await api("/api/llm/options");
  const prefs = loadPrefs();
  const { providers } = composerState.options;
  const okProviders = providers.filter((p) => p.configured);
  const preferred = [prefs.provider, ...providers.filter(p => p.active).map(p => p.provider)]
    .find((id) => id && okProviders.some((p) => p.provider === id));
  composerState.provider = preferred || okProviders[0]?.provider || providers[0]?.provider;
  composerState.effort = prefs.effort || composerState.options.default_effort || "medium";
  syncModelFromProvider(prefs.model);
  renderComposerSelects();
}

function currentProvider() {
  return (composerState.options?.providers || [])
    .find((p) => p.provider === composerState.provider);
}

function syncModelFromProvider(preferModel) {
  const p = currentProvider();
  if (!p) return;
  const list = p.models || [];
  const saved = loadPrefs();

  // 优先级：显式传入 > 该服务商上次选的模型 > 该服务商默认模型
  const remembered = saved.perProvider?.[p.provider];
  const candidates = [preferModel, remembered, p.default_model];
  let chosen = null;
  for (const c of candidates) {
    if (!c) continue;
    if (!list.length || list.includes(c)) { chosen = c; break; }
  }
  composerState.model = chosen || list[0] || p.default_model;
}

function renderComposerSelects() {
  const o = composerState.options;
  if (!o) return;

  const pSel = $("#composer-provider");
  pSel.innerHTML = o.providers.map((p) =>
    `<option value="${p.provider}" ${p.provider === composerState.provider ? "selected" : ""}>
       ${esc(p.label)}${p.configured ? "" : "（未配置）"}</option>`).join("");
  const cur = currentProvider();
  pSel.classList.toggle("set", !!cur?.configured);

  const mSel = $("#composer-model");
  const models = cur?.models || [];
  if (models.length) {
    mSel.innerHTML = models.map((m) =>
      `<option value="${esc(m)}" ${m === composerState.model ? "selected" : ""}>${esc(m)}</option>`).join("");
    mSel.hidden = false;
  } else {
    mSel.innerHTML = `<option>${esc(cur?.default_model || "")}</option>`;
    mSel.hidden = false;
  }

  const eSel = $("#composer-effort");
  eSel.innerHTML = o.efforts.map((e) =>
    `<option value="${e.value}" ${e.value === composerState.effort ? "selected" : ""}>
       思考·${esc(e.label)}</option>`).join("");
  eSel.classList.toggle("set", composerState.effort !== "off");

  // 未配置时明显提示
  if (!cur?.configured) {
    pSel.title = "该服务商未配置 API Key，点右上角 ⚙ 设置";
  }
}

/* ---------------------------------------------------------------- 流式生成 */
async function generateReply({ fromId = null } = {}) {
  const conv = state.activeConv;
  if (!conv || composerState.streaming) return;
  const leaf = fromId || lastMessageId();
  const btnSend = $("#btn-send"), btnStop = $("#btn-stop");

  composerState.streaming = true;
  btnSend.disabled = true;
  btnStop.hidden = false;
  $("#composer-input").disabled = true;

  const controller = new AbortController();
  composerState.abort = controller;

  // 插入占位气泡
  const holder = document.createElement("div");
  holder.className = "msg assistant streaming";
  holder.id = "msg-streaming";
  holder.innerHTML = `
    <div class="msg-head"><span class="who">🤖 助手</span>
      <span class="strength-tag" id="stream-tag">${
        esc(composerState.provider)} / ${esc(composerState.model)} · 思考·${
        esc(composerState.effort)}</span></div>
    <details class="thinking-block" id="stream-thinking" hidden open>
      <summary>💭 思考过程</summary><div class="thinking-body"></div>
    </details>
    <div class="msg-body md cursor-blink" id="stream-body"></div>`;
  $("#messages").appendChild(holder);
  holder.scrollIntoView({ behavior: "smooth", block: "end" });

  const bodyEl = () => $("#stream-body");
  const thinkEl = () => $("#stream-thinking");
  let text = "";
  let thinkingText = "";
  let savedId = null;
  // 流式渲染节流：避免每个 token 都全量重解析 Markdown
  let renderPending = false;
  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      bodyEl().innerHTML = MD.render(text);
    });
  };
  let errMsg = "";

  try {
    const res = await fetch(`/api/conversations/${conv.id}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        leaf_id: leaf,
        provider: composerState.provider,
        model: composerState.model,
        effort: composerState.effort,
      }),
    });

    if (!res.ok || !(res.headers.get("content-type") || "").includes("event-stream")) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `请求失败 (HTTP ${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let evt;
          try { evt = JSON.parse(raw); } catch { continue; }
          if (evt.type === "message_created") savedId = evt.id;
          if (evt.type === "text") {
            text += evt.text;
            scheduleRender();
            holder.scrollIntoView({ block: "end" });
          }
          if (evt.type === "thinking") {
            thinkingText += evt.text;
            thinkEl().hidden = false;
            $(".thinking-body", thinkEl()).textContent = thinkingText;
          }
          if (evt.type === "start" && evt.info) {
            const eff = evt.info.effort_effective;
            const tag = $("#stream-tag");
            if (tag) {
              const warn = evt.info.effort_requested !== eff
                ? `（已降为 ${eff}：该模型不支持推理参数）` : "";
              tag.textContent = `${evt.info.model} · 思考·${eff}${warn}`;
            }
          }
          if (evt.type === "error") errMsg = evt.message;
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") errMsg = "__aborted__";
    else errMsg = e.message;
  } finally {
    // 确保最后一帧已渲染（节流可能丢掉尾部更新）
    if (text && $("#stream-body")) $("#stream-body").innerHTML = MD.render(text);
    composerState.streaming = false;
    composerState.abort = null;
    btnSend.disabled = false;
    btnStop.hidden = true;
    $("#composer-input").disabled = false;

    if (errMsg && errMsg !== "__aborted__") {
      holder.classList.add("error-msg");
      bodyEl().classList.remove("cursor-blink");
      bodyEl().innerHTML = MD.render(text || "（无内容）");
      const errLine = document.createElement("div");
      errLine.className = "test-result bad";
      errLine.textContent = "✗ " + errMsg;
      holder.appendChild(errLine);
      toast(errMsg, 4000);
    } else if (!text && !thinkingText) {
      holder.remove();
      if (errMsg === "__aborted__") toast("已停止");
    }
  }

  // 无论成败都刷新一次，拿服务端落库的真实内容
  await openConv(conv.id);
  loadConvs();
}

function lastMessageId() {
  const conv = state.activeConv;
  if (!conv?.messages?.length) return null;
  const { main } = ancestryMap(conv.messages);
  const ordered = conv.messages.filter((m) => main.has(m.id));
  return ordered.length ? ordered[ordered.length - 1].id : null;
}

function stopStreaming() {
  composerState.abort?.abort();
}

/* ---------------------------------------------------------------- 发送消息 */
async function sendMessage(mode = "ai") {
  const input = $("#composer-input");
  const content = input.value.trim();
  if (!content || !state.activeConv || composerState.streaming) return;
  const role = $("#composer-role").value;

  await api(`/api/conversations/${state.activeConv.id}/messages`, {
    method: "POST",
    body: { role, content },
  });
  input.value = "";
  input.style.height = "auto";
  await openConv(state.activeConv.id);
  const newId = lastMessageId();
  $(`.msg[data-id="${newId}"]`)?.scrollIntoView({ behavior: "smooth", block: "end" });
  loadConvs();

  // 只有用户角色且选择生成时才请求 AI 回复
  const wantAI = mode === "ai" && role === "user";
  if (wantAI) {
    const p = currentProvider();
    if (!p?.configured) {
      toast("该服务商未配置 API Key，请点右上角 ⚙ 设置", 3500);
      return;
    }
    await generateReply();
  }
}

async function retryWithCurrent() {
  if (!state.activeConv) return;
  await generateReply();
}

async function saveTitle() {
  const title = $("#conv-title").textContent.trim() || "未命名会话";
  await api(`/api/conversations/${state.activeConv.id}`, { method: "PATCH", body: { title } });
  state.activeConv.title = title;
  loadConvs();
}

async function archiveConv() {
  await api(`/api/conversations/${state.activeConv.id}`, { method: "PATCH", body: { archived: 1 } });
  toast("已归档");
  state.activeConv = null;
  await loadConvs();
  await ensureConversation();
}

async function deleteConv() {
  if (!confirm("彻底删除该会话及其所有消息？")) return;
  await api(`/api/conversations/${state.activeConv.id}`, { method: "DELETE" });
  state.activeConv = null;
  toast("已删除");
  await loadConvs();
  await ensureConversation();
}

/** 打开应用时进入一个「可立即输入」的界面。
 *
 * 关键行为：不要自动跳进历史会话——那会让用户每次打开都被塞进
 * 某个旧对话里。若当前没有选中会话，就开一张新的空白会话；
 * 历史会话由用户自己在左侧列表选择。
 */
async function ensureConversation() {
  // 已经选中某个会话（如从历史里点开）则尊重它
  if (state.activeConv) return;

  // 复用最近一个「还没说过话」的空会话，避免每次刷新都堆积空壳
  const empty = state.convs.find((c) => c.message_count === 0);
  if (empty) return openConv(empty.id);

  const conv = await api("/api/conversations", {
    method: "POST",
    body: { title: "未命名会话", folder_ids: state.scopeFolder ? [state.scopeFolder] : [] },
  });
  // 建完后把其它遗留空会话收掉，只留这一个
  api("/api/maintenance/prune-empty",
    { method: "POST", body: { keep: conv.id, max_empty: 1 } })
    .catch(() => {});
  await loadConvs();
  return openConv(conv.id);
}

async function newConversation() {
  const conv = await api("/api/conversations", {
    method: "POST",
    body: { title: "未命名会话", folder_ids: state.scopeFolder ? [state.scopeFolder] : [] },
  });
  await loadConvs();
  await openConv(conv.id);
  $("#conv-title").focus();
}

/* ---------------------------------------------------------------- 归类弹窗 */
function openFolderPicker() {
  const modal = $("#modal-folders");
  const cur = new Set((state.activeConv.folders || []).map((f) => f.id));
  $("#modal-folder-list").innerHTML = state.folders.length
    ? state.folders.map((f) => `
        <label><input type="checkbox" value="${f.id}" ${cur.has(f.id) ? "checked" : ""}>
          <i class="dot" style="background:${f.color}"></i>${esc(f.name)}
          <span class="cnt" style="margin-left:auto;color:var(--dim);font-size:11px">${f.total}</span>
        </label>`).join("")
      + `<p class="hint">勾选后点击「保存」；一个会话可归入多个文件夹。</p>`
    : `<p class="hint">还没有文件夹，先到侧栏「文件夹」标签创建。</p>`;
  modal.hidden = false;
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn primary";
  saveBtn.textContent = "保存";
  saveBtn.onclick = async () => {
    const ids = $$("#modal-folder-list input:checked").map((i) => i.value);
    await api(`/api/conversations/${state.activeConv.id}/folders`,
      { method: "PUT", body: { folder_ids: ids } });
    modal.hidden = true;
    await openConv(state.activeConv.id);
    await loadFolders();
  };
  const foot = $(".modal-foot", modal);
  foot.innerHTML = "";
  const close = document.createElement("button");
  close.className = "btn ghost";
  close.textContent = "关闭";
  close.onclick = () => (modal.hidden = true);
  foot.append(close, saveBtn);
}

/* ---------------------------------------------------------------- 分享 / 导出 / 导入 */
async function doShare() {
  const branchOnly = $("#share-branch").checked;
  const info = await api(`/api/conversations/${state.activeConv.id}/share`,
    { method: "POST", body: { branch_only: branchOnly } });
  const full = location.origin + info.url;
  $("#share-out").innerHTML = `只读分享链接：<br><a href="${full}" target="_blank">${full}</a>`;
  try {
    await navigator.clipboard.writeText(full);
    toast("链接已复制到剪贴板");
  } catch { /* 剪贴板不可用时忽略 */ }
}

function download(fmt, branchOnly) {
  const url = `/api/conversations/${state.activeConv.id}/export?format=${fmt}`
    + (branchOnly ? "&branch_only=1" : "");
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function doImport() {
  const text = $("#import-text").value.trim();
  if (!text) return toast("请先粘贴内容");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return toast("JSON 解析失败");
  }
  try {
    const res = await api("/api/import", {
      method: "POST",
      body: { payload, format: $("#import-is-pi").checked ? "pi" : undefined },
    });
    $("#modal-import").hidden = true;
    $("#import-text").value = "";
    await loadConvs();
    await openConv(res.conversation.id);
    toast(`已导入 ${res.message_count} 条消息`);
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------------------------------------------------------- 收藏视图 */
async function loadFavorites() {
  const items = await api("/api/favorites");
  const box = $("#fav-list");
  if (!items.length) {
    box.innerHTML = `<p class="hint">还没有收藏。在消息上点「☆ 收藏」即可。</p>`;
    return;
  }
  box.innerHTML = items.map((m) => `
    <div class="fav-item" data-conv="${m.conv_id}" data-msg="${m.id}">
      <div>${esc((m.content || "").slice(0, 140))}${m.content.length > 140 ? "…" : ""}</div>
      <div class="src">${roleName(m.role)} · ${esc(m.conv_title)} · ${fmtTime(m.created_at)}</div>
    </div>`).join("");
  box.onclick = async (e) => {
    const el = e.target.closest(".fav-item");
    if (!el) return;
    await openConv(el.dataset.conv);
    setTimeout(() => $(`.msg[data-id="${el.dataset.msg}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
  };
}

/* ---------------------------------------------------------------- 视图切换 */
function switchView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
  if (name === "favorites") loadFavorites();
  if (name === "folders") loadFolders();
}

/* ---------------------------------------------------------------- 设置：API Key */
const settingsState = { status: null, current: "anthropic" };

async function openSettings() {
  settingsState.status = await api("/api/llm/status");
  const active = settingsState.status.active;
  settingsState.current = settingsState.status.providers.some((p) => p.provider === active)
    ? active : settingsState.status.providers[0].provider;
  renderSettings();
  $("#modal-settings").hidden = false;
}

function renderSettings() {
  const { providers } = settingsState.status;
  $("#provider-tabs").innerHTML = providers.map((p) => `
    <button data-p="${p.provider}" class="${p.provider === settingsState.current ? "active" : ""}">
      ${esc(p.label)}${p.configured ? ' <span style="color:var(--green)">•</span>' : ""}
    </button>`).join("");
  $("#provider-tabs").onclick = (e) => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    settingsState.current = b.dataset.p;
    renderSettings();
  };

  const p = providers.find((x) => x.provider === settingsState.current);
  const isActive = settingsState.status.active === p.provider;
  const statusBadge = p.env_locked
    ? `<span class="badge warn">已由环境变量提供</span>`
    : p.configured
      ? `<span class="badge ok">已配置</span>`
      : `<span class="badge off">未配置</span>`;
  const protoBadge = p.protocol === "anthropic"
    ? `<span class="badge off">Anthropic 协议</span>`
    : `<span class="badge off">OpenAI 兼容协议</span>`;
  const modelOpts = (p.models || []).map((m) => `<option value="${esc(m)}">`).join("");

  $("#provider-form").innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap">
      ${statusBadge}
      ${protoBadge}
      ${isActive ? '<span class="badge ok">当前使用</span>' : ''}
      ${p.masked ? `<span class="key-hint">已存：${p.masked}</span>` : ""}
    </div>

    <div class="field">
      <label>API Key</label>
      <div class="key-row">
        <input type="password" id="set-key" autocomplete="off" spellcheck="false"
               placeholder="${p.env_locked ? "由环境变量提供，无需填写" : "sk-..."}"
               ${p.env_locked ? "disabled" : ""}>
        <button class="btn ghost" id="btn-toggle-key" type="button"
                ${p.env_locked ? "disabled" : ""}>显示</button>
      </div>
      <div class="key-hint">${p.env_locked
        ? "检测到环境变量，优先生效；此处修改不会覆盖它。"
        : (p.key_hint || "留空表示不修改；保存后只显示尾 4 位。")}</div>
    </div>

    <div class="field">
      <label>Base URL</label>
      <input type="text" id="set-base" value="${esc(p.base_url)}"
             placeholder="${esc(p.default_base)}">
    </div>

    <div class="field">
      <label>模型</label>
      <input type="text" id="set-model" value="${esc(p.model)}"
             placeholder="${esc(p.default_model)}" list="model-suggests">
      <datalist id="model-suggests">${modelOpts}</datalist>
      ${(p.models || []).length ? `<div class="key-hint">可选：${p.models.map(esc).join(" · ")}</div>` : ""}
    </div>

    <div class="test-result" id="test-result" hidden></div>

    <div class="modal-foot" style="flex-wrap:wrap;justify-content:flex-start">
      <button class="btn primary" id="btn-save-key">保存</button>
      <button class="btn ghost" id="btn-test-key">测试连接</button>
      <button class="btn ghost" id="btn-use-provider" ${isActive ? "disabled" : ""}>
        ${isActive ? "已是当前" : "设为当前"}</button>
      ${p.masked ? '<button class="btn danger ghost" id="btn-clear-key">清除</button>' : ""}
    </div>`;

  $("#btn-toggle-key").onclick = () => {
    const inp = $("#set-key");
    inp.type = inp.type === "password" ? "text" : "password";
    $("#btn-toggle-key").textContent = inp.type === "password" ? "显示" : "隐藏";
  };
  $("#btn-save-key").onclick = saveKey;
  $("#btn-test-key").onclick = testKey;
  $("#btn-use-provider").onclick = async () => {
    await api("/api/llm/active", { method: "PUT", body: { provider: p.provider } });
    toast("已切换当前供应商");
    await openSettings();
  };
  const clearBtn = $("#btn-clear-key");
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm(`清除 ${p.label} 的 API Key？`)) return;
    await api(`/api/llm/config/${p.provider}`, { method: "DELETE" });
    toast("已清除");
    await openSettings();
  };
}

async function saveKey() {
  const p = settingsState.current;
  const keyVal = $("#set-key").value.trim();
  const body = {
    provider: p,
    base_url: $("#set-base").value.trim(),
    model: $("#set-model").value.trim(),
  };
  // 只有填了新 Key 才提交，避免把掩码占位符当真 Key 存回去
  if (keyVal) body.api_key = keyVal;
  settingsState.status = await api("/api/llm/config", { method: "PUT", body });
  toast(keyVal ? "已保存" : "设置已更新");
  renderSettings();
}

async function testKey() {
  const box = $("#test-result");
  box.hidden = false;
  box.className = "test-result";
  box.textContent = "正在测试…";
  try {
    const r = await api("/api/llm/test", {
      method: "POST", body: { provider: settingsState.current },
    });
    box.className = "test-result " + (r.ok ? "ok" : "bad");
    box.textContent = r.ok ? "✓ " + r.reason
      : `✗ ${r.reason}${r.status ? ` (HTTP ${r.status})` : ""}${r.detail ? ` · ${r.detail}` : ""}`;
  } catch (e) {
    box.className = "test-result bad";
    box.textContent = "✗ " + e.message;
  }
}

/* ---------------------------------------------------------------- 事件绑定 */
function bind() {
  MD.bindCopy(document.body);
  $("#btn-menu").onclick = () => $("#sidebar").classList.toggle("open");
  $("#btn-new").onclick = newConversation;
  $("#btn-new-folder").onclick = newFolder;
  $("#btn-clear-scope").onclick = () => {
    state.scopeFolder = null;
    state.search = "";
    $("#global-search").value = "";
    loadConvs();
    loadFolders();
  };
  $$(".tab").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));

  let searchTimer;
  $("#global-search").oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      loadConvs();
    }, 250);
  };
  $("#global-search").onkeydown = (e) => { if (e.key === "Escape") e.target.value = ""; };

  $("#conv-list").onclick = (e) => {
    const item = e.target.closest(".conv-item");
    if (item) openConv(item.dataset.id);
  };

  $("#messages").onclick = async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === "fav") return toggleFav(id);
    if (act === "edit") { state.editingMsgId = id; renderMessages(); $(`#edit-${id}`)?.focus(); }
    if (act === "cancel-edit") { state.editingMsgId = null; renderMessages(); }
    if (act === "save-edit") return saveBranchEdit(id);
    if (act === "tag") return addTag(id);
    if (act === "branch") return showBranches(id);
    if (act === "ask") {
      // 没选中文本时，用整条消息作为引文
      const msg = state.activeConv.messages.find((x) => x.id === id);
      if (!msg) return;
      document.querySelector(`#ask-bubble`)?.setAttribute("hidden", "");
      const bubble = document.querySelector("#ask-bubble");
      if (bubble) bubble.dataset.msgId = id;
      AskPanel.openWith((msg.content || "").slice(0, 4000));
      return;
    }
    if (act === "board") {
      await Board.addMessage(id, state.activeConv.id);
      return;
    }
    if (act === "regen") {
      await generateReply({ fromId: id });
      return;
    }
    if (act === "del") return deleteMsg(id);
  };

  $("#conv-title").onblur = () => { if (state.activeConv) saveTitle(); };
  $("#conv-title").onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  };
  $("#btn-archive").onclick = archiveConv;
  $("#btn-del-conv").onclick = deleteConv;

  $("#btn-export").onclick = (e) => {
    e.stopPropagation();
    $("#export-menu").classList.toggle("open");
  };
  $("#export-menu").onclick = (e) => {
    const b = e.target.closest("button[data-fmt]");
    if (!b) return;
    download(b.dataset.fmt, b.dataset.branch === "1");
    $("#export-menu").classList.remove("open");
  };
  document.addEventListener("click", () => $("#export-menu")?.classList.remove("open"));

  $("#btn-share").onclick = () => {
    $("#share-out").innerHTML = "";
    $("#modal-share").hidden = false;
  };
  $("#btn-do-share").onclick = doShare;

  $("#btn-import").onclick = () => ($("#modal-import").hidden = false);
  $("#btn-do-import").onclick = doImport;
  $("#btn-settings").onclick = openSettings;

  /* ---- 右侧历史栏 ---- */
  const threadbar = $("#threadbar");
  const toggleThread = (force) => {
    const isCollapsed = threadbar.classList.contains("collapsed");
    const willOpen = force !== undefined ? force : isCollapsed;
    threadbar.classList.toggle("collapsed", !willOpen);
    const btn = $("#btn-thread");
    if (btn) btn.classList.toggle("on", willOpen);
    $("#btn-thread-toggle").textContent = willOpen ? "⟩" : "⟨";
  };
  // 手机上默认收起，桌面默认展开
  toggleThread(window.innerWidth > 760);
  $("#btn-thread").onclick = () => toggleThread();
  $("#btn-thread-toggle").onclick = () => toggleThread();
  // 滚动联动高亮（节流）
  let scrollTick = false;
  $("#main").addEventListener("scroll", () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      ThreadView.setActiveFromScroll();
    });
  }, { passive: true });

  /* ---- 悬浮提问 ---- */
  AskPanel.bindSelection();
  $("#btn-snippets").onclick = () => AskPanel.openHistory();

  /* ---- 画板 ---- */
  Board.bind();
  // 预加载画板列表，以便消息底部按钮直接使用
  Board.loadBoards().catch(() => {});

  $$("[data-close]").forEach((b) => (b.onclick = () => (b.closest(".modal").hidden = true)));
  $$(".modal").forEach((m) => (m.onclick = (e) => { if (e.target === m) m.hidden = true; }));

  const input = $("#composer-input");
  input.oninput = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  };
  input.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendMessage("ai"); }
  };
  $("#btn-send").onclick = () => sendMessage("ai");
  $("#btn-send-only").onclick = () => sendMessage("save");
  $("#btn-stop").onclick = stopStreaming;

  $("#composer-provider").onchange = (e) => {
    composerState.provider = e.target.value;
    syncModelFromProvider(null);
    savePrefs();
    renderComposerSelects();
    const p = currentProvider();
    if (p && !p.configured) toast("该服务商未配置 Key，请点右上角 ⚙", 2600);
  };
  $("#composer-model").onchange = (e) => {
    composerState.model = e.target.value;
    savePrefs();
    renderComposerSelects();
  };
  $("#composer-effort").onchange = (e) => {
    composerState.effort = e.target.value;
    savePrefs();
    renderComposerSelects();
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $$(".modal").forEach((m) => (m.hidden = true));
      $("#export-menu")?.classList.remove("open");
    }
  });
}

/* ---------------------------------------------------------------- 启动 */
(async function init() {
  try {
    bind();
  } catch (e) {
    fatal("绑定事件", e);
    return;
  }
  // 各启动步骤独立容错：任何一步失败都不该让对话界面消失
  await loadFolders().catch((e) => fatal("加载文件夹", e));
  await loadConvs().catch((e) => fatal("加载会话列表", e));
  await loadComposerOptions().catch(() => { /* 离线/无 Key 时忽略 */ });
  Board.loadBoards().catch(() => {});
  try {
    await ensureConversation();      // 一进来就有可输入的对话界面
  } catch (e) {
    fatal("打开会话", e);
  }
  api("/api/stats").then((s) => console.info("ChatTool", s)).catch(() => {});
})();
