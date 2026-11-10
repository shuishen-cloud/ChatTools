/* ChatTool 前端逻辑（无构建步骤，原生 DOM） */

/* 部署子路径前缀（如 "/8000"，根路径部署时为空串）。
 *
 * 为什么不能在 JS 里从 location.pathname 推断：
 *   - 多级子路径（/tools/chattool）取第一段就错；
 *   - 分享页 /8000/s/<token> 与首页 /8000/ 深度不同，猜法不统一。
 * 所以由服务端在 index.html 里注入 window.__CT_PREFIX（读 CHATTOOL_PREFIX）。
 *
 * 不拼前缀的后果：/8000/ 下 fetch("/api/x") 会打到根路径 /api/x → 404，
 * 表现为页面能开、但所有数据加载、发消息、导出全部失败。 */
const PREFIX = window.__CT_PREFIX || "";

/** 给绝对路径加上部署前缀；非 "/" 开头（已是完整 URL）原样返回。 */
function withPrefix(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return path;
  return PREFIX + path;
}

// panels.js 在 app.js 之前加载，拿不到上面的局部符号，经 window 共享。
// 它内部的 fetch 都在事件回调里跑，此时本文件已执行完毕，可安全取用。
window.__ctWithPrefix = withPrefix;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  convs: [],
  archived: [],           // 归档会话（左侧「归档」页）
  archivedLoaded: false,  // 归档列表是否加载过（避免标签数字乱跳）
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

/* 把对话状态暴露给 panels.js 使用。
 *
 * 原因：panels.js 里的 Board / AskPanel 各自在闭包内定义了 `state`，
 * 会遮蔽这里的全局 `state`，直接写 `state.activeConv` 永远拿到 undefined。
 * 用一个显式命名的引用，避免两边同名状态互相踩。 */
window.__chattoolAppState = state;


async function api(path, opts = {}) {
  const res = await fetch(withPrefix(path), {
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

/* 安全绑定：元素不存在时只跳过，绝不让整个 bind() 中断。
 *
 * 血的教训：bind() 里原本全是 `$("#id").onclick = ...` 硬赋值。
 * 只要 HTML 少一个元素（典型场景：浏览器缓存了旧版 index.html，
 * 而 app.js 已是新版），就会抛 TypeError 把 bind() 打断在中间，
 * 后面所有事件——删除、归档、发送、切换会话——全部失效，
 * 表现就是「按钮点了没反应」。元素缺失应该只是少一个功能，
 * 不该让整个应用报废。 */
function on(sel, ev, fn, opts) {
  const el = typeof sel === "string" ? $(sel) : sel;
  if (!el) {
    console.warn(`[ChatTool] 绑定跳过：找不到 ${sel}（页面可能已更新，请强制刷新）`);
    return false;
  }
  el.addEventListener(ev, fn, opts);
  return true;
}

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
  updateArchiveTab();
  $("#conv-scope").textContent = state.scopeFolder
    ? (state.folders.find((f) => f.id === state.scopeFolder)?.name || "文件夹")
    : state.search ? `搜索：${state.search}` : "全部会话";
  $("#btn-clear-scope").hidden = !state.scopeFolder && !state.search;
}

/* 会话条目：右侧 ⋯（手机上常显、桌面 hover 出现），也支持长按 / 右键 */
function convItemHTML(c, { archived = false } = {}) {
  const folders = (c.folders || []).map((f) =>
    `<span class="chip"><i class="dot" style="background:${f.color}"></i>${esc(f.name)}</span>`).join("");
  return `
    <div class="conv-item ${state.activeConv?.id === c.id ? "active" : ""} ${archived ? "is-archived" : ""}"
         data-id="${c.id}">
      <div class="conv-row">
        <div class="t">${esc(c.title)}</div>
        <button class="conv-more-btn" data-act="menu" data-id="${c.id}"
                title="重命名 / 归档 / 删除" aria-label="会话操作">⋯</button>
      </div>
      <div class="p">${esc(c.preview || "（暂无消息）")}</div>
      <div class="meta">
        <span>${fmtTime(c.updated_at)}</span>
        <span>${c.message_count} 条</span>
        ${folders}
      </div>
    </div>`;
}

function renderConvs() {
  const box = $("#conv-list");
  if (!box) return;
  if (!state.convs.length) {
    box.innerHTML = `<p class="hint">还没有会话。点右上角「＋ 新会话」开始。</p>`;
    return;
  }
  box.innerHTML = state.convs.map((c) => convItemHTML(c)).join("");
}

/* ---------------------------------------------------------------- 已归档 */
async function loadArchived() {
  state.archived = await api("/api/conversations?archived=1");
  state.archivedLoaded = true;
  renderArchived();
  updateArchiveTab();
}

function renderArchived() {
  const box = $("#archive-list");
  if (!box) return;
  const list = state.archived || [];
  const emptyBtn = $("#btn-empty-archive");
  if (emptyBtn) emptyBtn.hidden = !list.length;
  if (!list.length) {
    box.innerHTML = `<p class="hint">没有归档的会话。在会话上长按/右键，或点 ⋯ →「归档」。</p>`;
    return;
  }
  box.innerHTML = list.map((c) => convItemHTML(c, { archived: true })).join("");
}

/** 归档标签上显示数量 */
function updateArchiveTab() {
  const tab = $('.tab[data-view="archive"]');
  if (!tab || !state.archivedLoaded) return;
  const n = (state.archived || []).length;
  tab.textContent = n ? `归档 ${n}` : "归档";
}

/** 启动时拉一次归档数量，让标签一进来就带数字 */
async function primeArchiveCount() {
  try {
    state.archived = await api("/api/conversations?archived=1");
    state.archivedLoaded = true;
    updateArchiveTab();
  } catch { /* 离线/出错不影响主界面 */ }
}

/** 会话操作菜单：列表里的条目、顶栏的 ⋯ 共用 */
function showConvMenu(convId, anchor) {
  const inArchive = (state.archived || []).some((c) => c.id === convId);
  const conv = state.convs.find((c) => c.id === convId)
    || (state.archived || []).find((c) => c.id === convId)
    || (state.activeConv?.id === convId ? state.activeConv : null);
  if (!conv) return;
  const archived = inArchive || !!conv.archived;

  // 菜单挂到 body：手机上 .sidebar 带 transform + overflow:hidden，
  // fixed 定位会相对侧栏并被裁掉，菜单等于看不见。
  const menu = $("#conv-more-menu");
  if (!menu) return;
  if (menu.parentElement !== document.body) document.body.appendChild(menu);

  menu.innerHTML = `
    <button data-act="rename">重命名</button>
    <button data-act="folders">归类到文件夹…</button>
    <hr>
    <button data-act="archive">${archived ? "↩ 恢复（取消归档）" : "归档"}</button>
    <button data-act="delete" class="is-danger">删除…</button>`;

  // 贴到触发元素旁，并夹在视口内
  const rect = (anchor || $("#btn-conv-more"))?.getBoundingClientRect()
    || { bottom: 60, left: 12 };
  const menuW = 200, menuH = 240;
  menu.style.position = "fixed";
  menu.style.right = "auto";
  menu.style.minWidth = `${menuW}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuH - 8))}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menuW - 8))}px`;

  menu.onclick = async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    closeConvMenu();
    const act = b.dataset.act;
    if (act === "rename") return renameConv(conv.id, conv.title);
    if (act === "folders") { await openConv(conv.id); return openFolderPicker(); }
    if (act === "archive") return archived ? unarchiveConv(conv.id) : archiveConvById(conv.id);
    if (act === "delete") return deleteConvById(conv.id, conv.title);
  };
  menu.classList.add("open");
  const topBtn = $("#btn-conv-more");
  if (topBtn) topBtn.setAttribute("aria-expanded", "true");
}

function closeConvMenu() {
  $("#conv-more-menu")?.classList.remove("open");
  const btn = $("#btn-conv-more");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

/** 顶栏「⋯」菜单开合 */
function closeTopMenu() {
  $("#top-more-menu")?.classList.remove("open");
  $("#btn-top-more")?.setAttribute("aria-expanded", "false");
}

async function renameConv(convId, current) {
  const title = prompt("会话名称", current || "未命名会话");
  if (title === null) return;
  const name = title.trim() || "未命名会话";
  await api(`/api/conversations/${convId}`, { method: "PATCH", body: { title: name } });
  if (state.activeConv?.id === convId) {
    state.activeConv.title = name;
    const t = $("#conv-title");
    if (t) t.textContent = name;
  }
  await loadConvs();
  if (state.archivedLoaded) await loadArchived();
  toast("已重命名");
}

async function archiveConvById(convId) {
  await api(`/api/conversations/${convId}/archive`, { method: "POST" });
  const wasActive = state.activeConv?.id === convId;
  if (wasActive) state.activeConv = null;
  await loadConvs();
  await loadArchived();
  toast("已归档，可在左侧「归档」恢复");
  if (wasActive) await ensureConversation();
}

async function unarchiveConv(convId) {
  await api(`/api/conversations/${convId}/archive`, { method: "DELETE" });
  await loadArchived();
  await loadConvs();
  toast("已恢复");
}

async function deleteConvById(convId, title) {
  if (!confirm(`彻底删除「${title || "该会话"}」及其所有消息？不可恢复。`)) return;
  await api(`/api/conversations/${convId}`, { method: "DELETE" });
  const wasActive = state.activeConv?.id === convId;
  if (wasActive) state.activeConv = null;
  await loadConvs();
  if (state.archivedLoaded) await loadArchived();
  toast("已删除");
  if (wasActive) await ensureConversation();
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
  // 会话标题变了，顶部 tab 要跟着变
  try { Board?.renderTabs?.(); } catch { /* 画板未就绪时忽略 */ }
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
          <button class="tool-btn" data-act="edit" data-id="${m.id}">✎ 编辑</button>
          <button class="tool-btn" data-act="ask" data-id="${m.id}">💬 提问</button>
          <details class="foot-more">
            <summary class="tool-btn">⋯</summary>
            <div class="foot-more-menu">
              <button class="tool-btn" data-act="tag" data-id="${m.id}"># 标签</button>
              <button class="tool-btn" data-act="branch" data-id="${m.id}">⌥ 查看分支</button>
              <button class="tool-btn" data-act="board" data-id="${m.id}">＋ 画板</button>
              <button class="tool-btn" data-act="board-other" data-id="${m.id}">加入其他画板…</button>
              ${m.role === "user" ? `<button class="tool-btn" data-act="regen" data-id="${m.id}">↻ 重新生成</button>` : ""}
              <button class="tool-btn is-danger" data-act="del" data-id="${m.id}">🗑 删除</button>
            </div>
          </details>
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
    const res = await fetch(withPrefix(`/api/conversations/${conv.id}/generate`), {
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
  // 新会话开成一个 tab（已存在则只切过去）
  try { await Board?.openChatTab?.(conv.id); } catch { /* 忽略 */ }
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
  const full = location.origin + withPrefix(info.url);
  $("#share-out").innerHTML = `只读分享链接：<br><a href="${full}" target="_blank">${full}</a>`;
  try {
    await navigator.clipboard.writeText(full);
    toast("链接已复制到剪贴板");
  } catch { /* 剪贴板不可用时忽略 */ }
}

function download(fmt, branchOnly) {
  const url = withPrefix(`/api/conversations/${state.activeConv.id}/export?format=${fmt}`
    + (branchOnly ? "&branch_only=1" : ""));
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

/* 分享收藏到 draw（上层绘图软件）：导出兼容 draw 的画布 JSON */
async function shareFavoritesToDraw() {
  const res = await api("/api/favorites/draw");
  const data = res;
  const count = (data.nodes || []).length;
  const name = `chattool-favorites-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });

  // 优先：浏览器支持目录写入时，尽量落到 draw 目录（用户选一次即可）
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "draw 画布", accept: { "application/json": [".json"] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      toast(`已导出 ${count} 张卡片，到 draw 里点「⬆ 导入」选择该文件`);
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;  // 用户取消
      console.warn("保存面板不可用，改用下载", e);
    }
  }

  // 退路：普通下载
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已导出 ${count} 张卡片，在 draw 里点「⬆ 导入」`);
}

/* ---------------------------------------------------------------- 视图切换 */
function switchView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
  if (name === "favorites") loadFavorites();
  if (name === "folders") loadFolders();
  // 画板标签：每次进入都刷新，才能看到其它入口刚改动的节点数/归类
  if (name === "boards") {
    Board.loadBoards().then(() => Board.renderSidebarList()).catch(() => {});
  }
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
  // 逐个绑定，每个都容错：任何一个元素缺失都不影响其余功能
  const guard = (label, fn) => {
    try { fn(); } catch (e) {
      console.error(`[ChatTool] 绑定「${label}」失败`, e);
      fatal(`绑定 ${label}`, e);
    }
  };

  guard("Markdown 复制按钮", () => MD.bindCopy(document.body));
  guard("白天黑夜", () => Theme.bind());

  /* ---- 顶栏 ---- */
  guard("顶栏", () => {
    on("#btn-new", "click", newConversation);
    on("#btn-new-board", "click", async () => {
      const name = prompt("画板名称", "新画板");
      if (!name) return;
      const b = await api("/api/boards", { method: "POST", body: { name } });
      await Board.loadBoards();
      await Board.openBoardTab(b.id);
      toast(`已创建「${b.name}」`);
    });
    on("#btn-settings", "click", openSettings);
    on("#btn-share", "click", () => { $("#share-out").innerHTML = ""; $("#modal-share").hidden = false; });
    on("#btn-do-share", "click", doShare);
    on("#btn-import", "click", () => { closeTopMenu(); $("#modal-import").hidden = false; });
    on("#btn-do-import", "click", doImport);
    on("#btn-snippets", "click", () => { closeTopMenu(); AskPanel.openHistory(); });
    // 顶栏「⋯」：低频入口（导入 / 画板 / 历史 / 提问记录）收进菜单，保持顶栏只留主操作
    on("#btn-top-more", "click", (e) => {
      e.stopPropagation();
      const open = $("#top-more-menu")?.classList.contains("open");
      closeTopMenu();
      if (!open) {
        $("#top-more-menu")?.classList.add("open");
        $("#btn-top-more")?.setAttribute("aria-expanded", "true");
      }
    });
    // 顶栏 ⋯：作用于当前会话
    on("#btn-conv-more", "click", (e) => {
      e.stopPropagation();
      if (!state.activeConv) return;
      if ($("#conv-more-menu")?.classList.contains("open")) return closeConvMenu();
      showConvMenu(state.activeConv.id, $("#btn-conv-more"));
    });
  });

  /* ---- 侧栏 ---- */
  guard("侧栏", () => {
    on("#btn-new-folder", "click", newFolder);
    on("#btn-fav-draw", "click", () => shareFavoritesToDraw().catch((e) => toast(e.message)));
    on("#btn-clear-scope", "click", () => {
      state.scopeFolder = null;
      state.search = "";
      const s = $("#global-search");
      if (s) s.value = "";
      loadConvs();
      loadFolders();
    });
    $$(".tab").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));
  });

  /* ---- 搜索 ---- */
  guard("搜索", () => {
    let searchTimer;
    on("#global-search", "input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value.trim();
        loadConvs();
        // 画板列表也复用同一个搜索框过滤
        try { Board?.renderSidebarList?.(); } catch { /* 未就绪 */ }
      }, 250);
    });
    on("#global-search", "keydown", (e) => { if (e.key === "Escape") e.target.value = ""; });
  });

  /* ---- 会话列表 / 归档列表：点击、长按、右键 ---- */
  guard("会话列表", () => {
    const bindConvList = (box, { openOnClick }) => {
      if (!box) return;
      box.onclick = (e) => {
        const btn = e.target.closest?.("[data-act='menu']");
        const item = e.target.closest?.(".conv-item");
        if (!item) return;
        if (btn) return showConvMenu(item.dataset.id, btn);
        // 点会话 = 开/切到该会话的 tab（已开则切过去，不重复开）
        if (openOnClick) {
          const id = item.dataset.id;
          if (typeof Board !== "undefined" && Board?.openChatTab) {
            Board.openChatTab(id).catch(() => openConv(id));
          } else {
            openConv(id);
          }
        }
      };
      box.oncontextmenu = (e) => {
        const item = e.target.closest(".conv-item");
        if (!item) return;
        e.preventDefault();
        showConvMenu(item.dataset.id, item);
      };
      // 手机长按 500ms
      let timer = null, moved = false;
      box.addEventListener("pointerdown", (e) => {
        const item = e.target.closest(".conv-item");
        if (!item) return;
        moved = false;
        timer = setTimeout(() => {
          if (!moved) {
            showConvMenu(item.dataset.id, item);
            if (navigator.vibrate) navigator.vibrate(12);
          }
        }, 500);
      });
      const cancel = () => { clearTimeout(timer); timer = null; };
      ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => box.addEventListener(ev, cancel));
      box.addEventListener("pointermove", () => { moved = true; cancel(); });
      box.addEventListener("scroll", cancel, true);
    };
    bindConvList($("#conv-list"), { openOnClick: true });
    bindConvList($("#archive-list"), { openOnClick: true });

    on("#btn-empty-archive", "click", async () => {
      const n = (state.archived || []).length;
      if (!n) return;
      if (!confirm(`彻底删除这 ${n} 个已归档会话及其全部消息？不可恢复。`)) return;
      for (const c of [...state.archived]) {
        await api(`/api/conversations/${c.id}`, { method: "DELETE" });
      }
      await loadArchived();
      toast("已清空归档");
    });
  });

  /* ---- 会话标题 ---- */
  guard("会话标题", () => {
    on("#conv-title", "blur", () => { if (state.activeConv) saveTitle(); });
    on("#conv-title", "keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    });
  });

  /* ---- 导出菜单 ---- */
  guard("导出菜单", () => {
    on("#btn-export", "click", (e) => {
      e.stopPropagation();
      $("#export-menu").classList.toggle("open");
    });
    on("#export-menu", "click", (e) => {
      const b = e.target.closest("button[data-fmt]");
      if (!b) return;
      download(b.dataset.fmt, b.dataset.branch === "1");
      $("#export-menu").classList.remove("open");
    });
  });

  /* ---- 消息列表 ---- */
  guard("消息列表", () => {
    on("#messages", "click", async (e) => {
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
        const msg = state.activeConv.messages.find((x) => x.id === id);
        if (!msg) return;
        document.querySelector("#ask-bubble")?.setAttribute("hidden", "");
        const bubble = document.querySelector("#ask-bubble");
        if (bubble) bubble.dataset.msgId = id;
        AskPanel.openWith((msg.content || "").slice(0, 4000));
        return;
      }
      if (act === "board") {
        await Board.addToActiveBoard(id, state.activeConv.id);
        return;
      }
      if (act === "board-other") {
        // 强制弹窗选择（即使已经有“上次的画板”）
        await Board.addMessage(id, state.activeConv.id, { forcePick: true });
        return;
      }
      if (act === "regen") { await generateReply({ fromId: id }); return; }
      if (act === "del") return deleteMsg(id);
    });
  });

  /* ---- 右侧历史栏 ---- */
  guard("历史栏", () => {
    const threadbar = $("#threadbar");
    if (!threadbar) return;
    const toggleThread = (force) => {
      const isCollapsed = threadbar.classList.contains("collapsed");
      const willOpen = force !== undefined ? force : isCollapsed;
      threadbar.classList.toggle("collapsed", !willOpen);
      const btn = $("#btn-thread");
      if (btn) btn.classList.toggle("on", willOpen);
      const t = $("#btn-thread-toggle");
      if (t) t.textContent = willOpen ? "⟩" : "⟨";
    };
    toggleThread(window.innerWidth > 760);
    on("#btn-thread", "click", () => toggleThread());
    on("#btn-thread-toggle", "click", () => toggleThread());
    let scrollTick = false;
    // 滚动实际发生在 #detail 内部（.main 不再自己滚），监听必须跟着改，
    // 否则右侧历史栏的双向联动会静默失效
    on("#detail", "scroll", () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => {
        scrollTick = false;
        ThreadView.setActiveFromScroll();
      });
    }, { passive: true });
  });

  /* ---- 侧栏开合（专注模式）---- */
  guard("侧栏开合", () => {
    const sidebar = $("#sidebar");
    if (!sidebar) return;
    const isMobile = () => window.innerWidth <= 760;

    const applyBtn = () => {
      const btn = $("#btn-menu");
      if (!btn) return;
      // 收起状态才点亮，提示“可以展开”
      const closed = isMobile()
        ? !sidebar.classList.contains("open")
        : sidebar.classList.contains("collapsed");
      btn.classList.toggle("on", closed);
      btn.setAttribute("aria-expanded", String(!closed));
      btn.title = closed ? "展开侧栏" : "收起侧栏";
    };

    const toggleSidebar = () => {
      if (isMobile()) {
        sidebar.classList.toggle("open");
      } else {
        // 桌面端：折叠成 0 宽，把空间全让给对话
        sidebar.classList.toggle("collapsed");
        try {
          localStorage.setItem("chattool.sidebar",
            sidebar.classList.contains("collapsed") ? "collapsed" : "open");
        } catch { /* 隐私模式忽略 */ }
      }
      applyBtn();
    };

    // 恢复上次状态（仅桌面端；手机端始终是抽屉）
    try {
      if (!isMobile() && localStorage.getItem("chattool.sidebar") === "collapsed") {
        sidebar.classList.add("collapsed");
      }
    } catch { /* 忽略 */ }

    on("#btn-menu", "click", toggleSidebar);
    // 手机端点主区关闭抽屉
    on("#main", "click", () => {
      if (isMobile() && sidebar.classList.contains("open")) {
        sidebar.classList.remove("open");
        applyBtn();
      }
    });
    // 缩放到桌面时清掉抽屉状态，避免侧栏卡在“开了但窄屏样式”
    window.addEventListener("resize", () => {
      if (!isMobile()) sidebar.classList.remove("open");
      applyBtn();
    });
    applyBtn();
  });

  /* ---- 悬浮提问 ---- */
  guard("悬浮提问", () => AskPanel.bindSelection());

  /* ---- 画板 ---- */
  guard("画板", () => {
    Board.bind();
    Board.loadBoards().catch(() => {});
  });
  /* ---- 弹窗通用关闭 ---- */
  guard("弹窗", () => {
    $$("[data-close]").forEach((b) => (b.onclick = () => (b.closest(".modal").hidden = true)));
    $$(".modal").forEach((m) => (m.onclick = (e) => { if (e.target === m) m.hidden = true; }));
  });

  /* ---- 输入区：发送 / 仅存 / 停止 ---- */
  guard("输入区", () => {
    on("#composer-input", "input", (e) => {
      const input = e.target;
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 200) + "px";
    });
    on("#composer-input", "keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendMessage("ai"); }
    });
    on("#btn-send", "click", () => sendMessage("ai"));
    on("#btn-send-only", "click", () => sendMessage("save"));
    on("#btn-stop", "click", stopStreaming);
  });

  /* ---- 服务商 / 模型 / 思考强度 ---- */
  guard("模型选择", () => {
    on("#composer-provider", "change", (e) => {
      composerState.provider = e.target.value;
      syncModelFromProvider(null);
      savePrefs();
      renderComposerSelects();
      const p = currentProvider();
      if (p && !p.configured) toast("该服务商未配置 Key，请点右上角 ⚙", 2600);
    });
    on("#composer-model", "change", (e) => {
      composerState.model = e.target.value;
      savePrefs();
      renderComposerSelects();
    });
    on("#composer-effort", "change", (e) => {
      composerState.effort = e.target.value;
      savePrefs();
      renderComposerSelects();
    });
  });

  /* ---- 全局键盘 ---- */
  guard("全局快捷键", () => {
    document.addEventListener("click", (e) => {
      $("#export-menu")?.classList.remove("open");
      // 菜单内部的点击不要关（交给菜单自己的 handler 处理）；
      // 触发按钮（顶栏 ⋯ 与列表里的 ⋯）也不要关，否则“开了又被关”。
      if (e.target.closest?.("#top-more-menu") || e.target.closest?.("#btn-top-more")) return;
      closeTopMenu();
      if (e.target.closest?.("#conv-more-menu")) return;
      if (e.target.closest?.("[data-act='menu']")) return;
      if (e.target.closest?.("#btn-conv-more")) return;
      closeConvMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        $$(".modal").forEach((m) => (m.hidden = true));
        $("#export-menu")?.classList.remove("open");
        closeConvMenu();
      }
    });
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
  await Board.loadBoards().catch(() => {});
  // 恢复上次的一级视图（对话 / 某块画板），刷新不丢位置
  await Board.restoreView().catch(() => {});
  try {
    await ensureConversation();      // 一进来就有可输入的对话界面
  } catch (e) {
    fatal("打开会话", e);
  }
  api("/api/stats").then((s) => console.info("ChatTool", s)).catch(() => {});
})();
