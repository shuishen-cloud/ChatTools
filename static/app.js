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
  $("#empty-state").hidden = true;
  $("#detail").hidden = false;
  $("#conv-title").textContent = state.activeConv.title;
  renderConvFolders();
  renderMessages();
  renderConvs();
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
    const body = editing
      ? `<textarea class="edit-area" id="edit-${m.id}">${esc(m.content)}</textarea>
         <div class="msg-foot" style="opacity:1">
           <button class="tool-btn" data-act="save-edit" data-id="${m.id}">保存为分支</button>
           <button class="tool-btn" data-act="cancel-edit">取消</button>
         </div>`
      : `<div class="msg-body">${esc(m.content)}</div>`;
    return `
      <div class="msg ${m.role} ${dim} ${faved}" data-id="${m.id}">
        <div class="msg-head">
          <span class="who">${roleName(m.role)}</span>
          <span>${fmtTime(m.created_at)}</span>
          ${m.favorite ? '<span style="color:var(--gold)">⭐</span>' : ""}
          ${tags}${multi}
        </div>
        ${body}
        ${editing ? "" : `<div class="msg-foot">
          <button class="tool-btn ${m.favorite ? "on" : ""}" data-act="fav" data-id="${m.id}">
            ${m.favorite ? "⭐ 已收藏" : "☆ 收藏"}</button>
          <button class="tool-btn" data-act="edit" data-id="${m.id}">✎ 编辑分支</button>
          <button class="tool-btn" data-act="tag" data-id="${m.id}"># 标签</button>
          <button class="tool-btn" data-act="branch" data-id="${m.id}">⌥ 查看分支</button>
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

/* ---------------------------------------------------------------- 会话操作 */
async function sendMessage() {
  const input = $("#composer-input");
  const content = input.value.trim();
  if (!content || !state.activeConv) return;
  await api(`/api/conversations/${state.activeConv.id}/messages`, {
    method: "POST",
    body: { role: $("#composer-role").value, content },
  });
  input.value = "";
  input.style.height = "auto";
  await openConv(state.activeConv.id);
  $("#messages").lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
  loadConvs();
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
  $("#detail").hidden = true;
  $("#empty-state").hidden = false;
  loadConvs();
}

async function deleteConv() {
  if (!confirm("彻底删除该会话及其所有消息？")) return;
  await api(`/api/conversations/${state.activeConv.id}`, { method: "DELETE" });
  state.activeConv = null;
  $("#detail").hidden = true;
  $("#empty-state").hidden = false;
  await loadConvs();
  toast("已删除");
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

  $("#provider-form").innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
      ${statusBadge}
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
        : "留空表示不修改；保存后只显示尾 4 位。"}</div>
    </div>

    <div class="field">
      <label>Base URL</label>
      <input type="text" id="set-base" value="${esc(p.base_url)}"
             placeholder="${esc(p.default_base)}">
    </div>

    <div class="field">
      <label>模型</label>
      <input type="text" id="set-model" value="${esc(p.model)}"
             placeholder="${esc(p.default_model)}">
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

  $$("[data-close]").forEach((b) => (b.onclick = () => (b.closest(".modal").hidden = true)));
  $$(".modal").forEach((m) => (m.onclick = (e) => { if (e.target === m) m.hidden = true; }));

  const input = $("#composer-input");
  input.oninput = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  };
  input.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendMessage(); }
  };
  $("#btn-send").onclick = sendMessage;

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $$(".modal").forEach((m) => (m.hidden = true));
      $("#export-menu")?.classList.remove("open");
    }
  });
}

/* ---------------------------------------------------------------- 启动 */
(async function init() {
  bind();
  await loadFolders();
  await loadConvs();
  if (state.convs.length) openConv(state.convs[0].id);
  const stats = await api("/api/stats").catch(() => null);
  if (stats) console.info("ChatTool", stats);
})();
