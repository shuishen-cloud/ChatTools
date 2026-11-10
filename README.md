# ChatTool · 对话脉络管理器

把散落各处的对话记录变成**可归类、可分支、可分享**的知识资产。

针对移动端对话工具的常见短板：无法把多个会话纳入同一框架观察脉络、无法多对多归类、无法导出分享、无法管理单轮对话。

## 功能

| 能力 | 说明 |
|---|---|
| **会话多对多归类** | 一个会话可同时属于多个文件夹（如「论文」+「本周复盘」），文件夹支持嵌套，形成脉络树 |
| **消息树 / 分支** | 消息以父子树存储。编辑任意一条消息会生成**新的兄弟分支**，原历史完整保留；可在分支间穿梭对比 |
| **单轮管理** | 逐条消息收藏、打标签、编辑、删除；收藏夹跨会话聚合查看 |
| **导出** | Markdown / 独立 HTML / JSON / 纯文本；支持「仅导出当前分支」；中文文件名按 RFC 5987 编码 |
| **分享** | 一键生成只读链接 `/s/<token>`，纯 HTML 页面，未登录可直接看；可撤销 |
| **导入** | ChatTool 自有 JSON 回流；直接解析 **Pi** 会话导出；宽松解析其他 `{messages:[...]}` 结构 |
| **会话归档 / 删除** | 会话条目点 ⋯（或长按 / 右键）即可重命名、归档、删除；侧栏「归档」页可查看与恢复，手机端同样可用 |
| **移动优先** | 单页无构建、响应式；Termux / 手机浏览器可用 |
| **界面克制** | 顶栏只留「☰ / 搜索 / ＋ / ⋯ / 🌙 / ⚙」；低频入口（导入、画板、历史栏、提问记录）收进 ⋯ 菜单 |
| **专注模式** | 左侧栏与右侧历史栏都可收起（左栏宽度归零，右栏塌成 0），把整个宽度让给对话；状态存本地 |
| **白天 / 黑夜模式** | 顶栏 ☀️/🌙 一键切换，可选「跟随系统」；选择存本地，首帧即生效不闪白 |
| **API Key 设置** | 右上角 ⚙ 打开设置，支持 **DeepSeek** / Anthropic / OpenAI 兼容；存服务端、只回显尾 4 位；可测连接 |
| **真对话生成** | 底部输入框发送后**流式请求 AI 回复**并落库；可中途停止；失败会记录错误而非丢消息 |
| **服务商 / 模型 / 思考强度切换** | 聊天框底部三个下拉：服务商、模型、思考档位（关/低/中/高），选择本地记忆 |
| **推理过程可见** | 支持推理的模型会流式显示「思考过程」，与正文分开保存 |
| **分支感知上下文** | 生成时只把当前分支的祖先链发给模型，兄弟分支互不污染 |
| **右侧历史快速切换** | 右栏把消息树渲染成脉络，与滚动双向联动，可折叠分支、一键跳转 |
| **悬浮提问窗** | 选中任何文字浮现「💬 就此提问」，弹出**可拖动的悬浮窗**；回答可一键加入画板 |
| **提示词画板** | 把任意会话的消息「＋ 画板」，在画布上拖拽布局、连线写出关系，可导出 Markdown |
| **多对话 tab** | 顶部 tab 可同时打开多个会话与多块画板，点即切换；切回时回到上次阅读位置 |
| **画板与对话同级** | 对话与画板同属一级视图，画板不再盖住对话 |
| **分享到 draw** | 收藏**直接从 ChatTool 同步**进 draw（CORS + fetch，无需导文件）；也保留导出 JSON 兜底 |

## 一次“按钮全都没反应”的事故

**症状**：更新之后删除卡顿且没反应、发消息没有回复、切换不了会话。

**根因**：`bind()` 里原本全是 `$("#id").onclick = ...` 这样的硬赋值。

```js
function bind() {
  MD.bindCopy(document.body);
  $("#btn-menu").onclick = ...;     // 只要前面任何一个元素缺失
  $("#btn-empty-archive").onclick = ...;  // ← 编辑器选一个，整个函数就崩在这里
  // ↓ 后面全部不执行：删除、归档、发送、切换会话、快捷键……
}
```

浏览器缓存了旧版 `index.html`（缺本轮新增的元素），`app.js` 却是新版，
`$("#btn-empty-archive")` 返回 `null`，赋值抛 `TypeError`，
**`bind()` 中断在第一半，后面的事件一个都没绑上**。
界面上看就是“点了没反应”，而不是报错——所以很难猜。

**三处修复**：

1. **安全绑定**：新增 `on(sel, ev, fn)`，元素缺失只 `console.warn` 并跳过。
   整个 `bind()` 拆成 12 个 `guard("分组名", fn)`，任一组出错只影响该组。
   元素缺失只应少一个功能，不该让整个应用报废。
2. **缓存头**：`StaticFiles` 默认不发 `Cache-Control`，浏览器按启发式规则
   长期缓存 JS。现在给 `/` 和 `/static/*` 加 `no-cache` + ETag
   （每次都回来验证，没变就 304，不浪费流量），避免新旧版本混用。
3. **禁止回归**：`test_69c` 扫描 `bind()` 函数体，**断言里面不得再出现
   任何 `$("#x").onclick = ` 裸赋值**，并要求至少 8 个 `guard` 分组。

验证方式：用 jsdom 把「旧 HTML + 新 JS」拼起来跑，修复前输出
`启动失败（绑定事件）：Cannot set properties of null (setting 'onclick')`，
修复后无错误，且切换会话 / 归档 / 恢复全部通过。

## 会话的归档与删除

会话条目右侧有 **⋯**（手机上常显、桌面 hover 出现），也可以**长按**（触屏）或**右键**：
重命名 / 归类到文件夹 / 归档 / 删除。顶栏的 ⋯ 作用于当前会话。

> **同一功能只有一个入口**：归档与删除只在 ⋯ 菜单里，不再在详情头另放一兑按钮；
> 菜单里也不再放「打开」（点会话条目本身就是打开）。
> `test_69` 会断言 ⋯ 菜单里 rename / archive / delete 三个动作仍然存在。

### 两侧栏都能收起

| 区域 | 收起方式 | 效果 |
|---|---|---|
| 左侧栏 | 顶栏 **☰** | 桌面端宽度归零（真正让出空间），手机端为抽屉 |
| 右侧历史 | ⋯ 菜单「历史栏」/ 栏内 ⟨ | 桌面端 `width → 0`，手机端抽屉 |

桌面端的侧栏状态存 `localStorage["chattool.sidebar"]`，下次打开保持。
**收起后入口仍在顶栏**，不会出现「收了就再也打不开」的死锁。
`btn-menu` 常显（不再只属于移动端），收起时高亮提示可展开。

侧栏第四个标签 **归档** 列出所有已归档会话，可单个恢复，也可「清空」批量删除。

| 接口 | 语义 |
|---|---|
| `POST /api/conversations/{id}/archive` | 归档（只置标记，**不动消息**） |
| `DELETE /api/conversations/{id}/archive` | 恢复，回到会话列表 |
| `DELETE /api/conversations/{id}` | 彻底删除，外键级联清掉消息与文件夹关联 |

### 两个踩过的坑

1. **手机端把按钮 `display:none` 掉了**：旧 CSS 里有
   `@media (max-width:760px){ #btn-del-conv, #btn-archive { display:none } }`，
   于是手机上根本删不掉会话。现在删除/归档都收敛进 ⋯ 菜单，
   测试 `test_69` 会断言这行样式不得回归。
2. **菜单被侧栏裁掉**：手机端 `.sidebar` 带 `transform: translateX(-100%)`
   且有 `overflow: hidden`——`transform` 让侧栏成为 `position: fixed`
   的包含块，菜单被裁得只剩一条边。所以菜单节点放在 `<body>` 下，
   JS 里用 `appendChild` + `getBoundingClientRect()` 贴到触发元素旁。
   测试 `test_69b` 锁住这一点。

归档早期只有「进入」没有「出去」：后端能查 `archived=1`，前端却没有入口，
按一下归档会话就永久消失。现在归档必须可逆，`test_65/66` 断言
「归档后能查到、恢复后回列表、消息一条不少」。

## 白天 / 黑夜模式

顶栏「🌙 / ☀️」按钮一键在白天与黑夜之间切换；**右键 / 长按**该按钮可打开三态菜单：

| 模式 | 说明 |
|---|---|
| 跟随系统（默认） | 读 `prefers-color-scheme`，系统切深色时页面自动跟随 |
| 白天 | 强制浅色 |
| 黑夜 | 强制深色（原有外观） |

快捷键 `Ctrl/⌘ + Shift + L`。选择存在 `localStorage["chattool.theme"]`。

### 实现要点

1. **变量化**：CSS 顶部 `:root` 定义黑夜全部颜色，`html[data-theme="light"]` 覆盖为白天；
   切换主题只是改 `<html data-theme>`，无 JS 重绘。几何参数（`--radius`）不参与换肤。
2. **不闪白**：`index.html` 的 `<head>` 内联一段脚本，在首帧渲染前就定好 `data-theme`——
   否则「跟随系统 + 系统为日间」时会先黑一下再变白。
3. **正文零硬编码色**：所有十六进制色收进变量（含 `--ok-bg` / `--err-line` 这类语义色），
   否则浅色主题下会出现深色残留。`tests/theme.test.js` 会扫描正文并断言"两套主题定义了同一组变量"。
4. **SVG 例外**：画板连线的颜色写在 SVG 属性里，`var()` 无效，所以 `panels.js` 的 `skin()`
   从 `getComputedStyle` 读当前主题色值，换肤后调 `Board.refresh()` 重绘连线。
5. **系统 UI 跟随**：切主题时同步更新 `color-scheme` 与 `theme-color`，
   手机浏览器状态栏 / 表单控件（select、滚动条）也会变成对应明暗。

测试 `tests/theme_logic.test.js` 用最小 DOM 打桩跑 `theme.js`，锁住
「auto 跟随系统 / 显式指定 / 一键切换」三种行为。

## 设计原则：先对话，再组织

主界面**永远**是一个可用的对话界面，不存在「先选会话才能聊天」的门檻：

- 打开页面时若无任何会话，自动创建一个空会话（`ensureConversation()`）
- 空会话就显示引导文案 + 输入框，直接打字就能发
- 对话发生后，再去组织：收藏 / 分支 / 标签 / 文件夹 / 画板

技术上，早期版本用 `#detail[hidden]` 切换「空状态 ↔ 对话」两套界面，
一旦 `openConv()` 中途抛错就永远停在白屏。现在**只保留一套界面**，
少一个失败点；启动各步骤独立容错，出错会显式显示在 `#boot-error` 里
而不是静默白屏。

测试 `test_41~43` 锁住这个契约：会话详情必含 `messages/main_branch/folders`、
首页 `#detail` 不得带 `hidden`、空会话的历史栏接口也要返回合法结构。

### 另一个坑：`hidden` 被 CSS 的 display 覆盖

HTML 的 `hidden` 属性只是 UA 样式表里的 `display: none`，
**优先级低于任何类选择器**。所以 `.boardview { display: flex }`
会直接让 `#boardview hidden` 失效——画板全屏遮罩（`position:fixed; inset:0; z-index:150`）
从页面一加载就盖住整个对话界面，看到的只有画板。

修法：CSS 顶部加全局兜底，并对全屏层单独声明：

```css
[hidden] { display: none !important; }
.boardview[hidden] { display: none; }
```

`tests/css_hidden.test.js` 扫描所有带 `hidden` 的元素，
检查其类的 `display` 声明能否被兜底，防止再犯。

## 对话生成与思考强度

### 为什么之前「测试正常但不回复」

早期版本的计划中，⚙ 设置里的「测试连接」是一条独立的凭证探针（`_probe`），它只验证 Key 能否调通上游；而**聊天框的发送按钮只把消息写入数据库，从来没有调用过 LLM**。两者看似矛盾，实际上是两个不相干的路径。现在已接通：发送 → 保存 → 流式生成 → 落库。

### 底部控制条

输入框上方三个下拉，选择会记在 `localStorage`（按服务商分别记住上次的模型）：

| 控件 | 说明 |
|---|---|
| 服务商 | 列出全部 provider，未配置 Key 的会标「未配置」 |
| 模型 | 该服务商的模型列表（如 `deepseek-chat` / `deepseek-reasoner`） |
| 思考强度 | `关闭 / 低 / 中 / 高` |

发送按钮旁还有 **仅存**（只写消息不请求回复，方便先批量整理）和生成中的 **停止**。
仅存与角色下拉在输入框**下方**的工具条里，输入框本身始终保持在同一位置，不会被控件推来推去。

### 思考强度如何映射

统一抽象 `off / low / medium / high`，按协议翻译：

| 协议 | 参数 | 预算 |
|---|---|---|
| Anthropic | `thinking: {type: enabled, budget_tokens}` | low 2048 / medium 8192 / high 24576 |
| OpenAI 兼容 | `reasoning_effort` | low / medium / high |
| 关闭 | 不推理，改发 `temperature: 0.7` | — |

**自动降级**：选中的模型若不支持推理参数（如 `deepseek-chat`、`gpt-4o`），会降为 `off` 并跳过该字段，而不是被上游 400 拒绝。前端会提示「已降为 off：该模型不支持推理参数」。

> Anthropic 协议下开启 thinking 时不允许传 `temperature`，因此会自动省略；同时保证 `max_tokens > budget_tokens`，否则上游会报错。

### 分支与上下文

`branch_context()` 只取**当前叶子的祖先链**，因此：

- 在分支 A 继续对话，模型看不到分支 B 的内容；
- 「重新生成」按钮针对被点击的那条 user 消息重开一条兄弟分支，旧回答保留。

## 右侧历史 / 悬浮提问 / 画板

### 右侧历史快速切换

右栏 `ThreadView` 把消息树渲染为可折叠脉络：

- 分支点显示 `🔀 N`，旁支消息淡化显示
- 点击任一项平滑滚动到对应消息并短暂高亮
- **双向联动**：滚动正文时，历史栏自动高亮当前消息并把它滚进可视区
- 点击箭头只折叠，不跳转；点正文才跳转
- 顶栏 ⋯ 菜单「历史栏」开关；桌面默认展开，手机默认收起（抽屉式）
- `.main` 设了 `min-width: 0`，否则长内容会把右栏挤出视口

接口：`GET /api/conversations/{id}/thread` → 递归树 + `main_branch`。

### 悬浮提问窗

在消息里**选中任意文字** → 浮出「💬 就此提问」→ **可拖动的悬浮窗**流式回答。

- 窗口可拖动（拖标题栏）、可缩放（右下角），不会挡住你正在看的内容
- 左上「＋ 画板」把「引文 + 问题 + 回答」打包成一条消息直接加入画板
- 顶栏 ⋯ 菜单「提问记录」可回看该会话所有悬浮问答

- 回答存入 `snippet_qa` 表，**不写入消息树**，所以不会弄乱对话主线
- 顶部「提问记录」可回看该会话的所有悬浮问答
- 没选中文本时，消息底部的「💬 提问」按钮会用整条消息当引文
- 提问走独立 system prompt（不复述引文、信息不足时明确指出）

### 提示词画板

**顶部 tab 同时管理会话与画板**（详情见 `doc/feat/multi-chat-tabs.md`）：

```
💬 论文讨论 ✕   💬 代码排查 ✕   🎨 复盘 ✕   ＋
```

- 点侧栏任意会话 → 开一个新 tab；**已打开则只切过去**，不会重复
- 点 `＋` → 弹窗同时列出「画板」与「会话」，选哪个开哪个
- 点 tab → 切过去；会话会**回到你上次看到的位置**
- 点 `✕` → 关掉；关的是当前项时回落到相邻 tab，没有就开一个新会话

**为什么不支持「同一会话开两个位置」**：`state.activeConv` 是单例，
同一会话开两个实例就必须做两视图数据同步，否则一边改完另一边还显示旧内容——
这是数据正确性问题，不是 UI 问题。而真实痛点（长对话翻上去看、回来找不到位置）
用**滚动位置记忆**已解决：记“最靠上的可见消息 id”作锚点，
而不是存像素——消息高度会因图片/表格变化，纯像素会飘。
滚动位置只存内存（`Map`），刷新后不恢复，避免“一打开就在中间”的怪异感。

**以前的局限**：对话 tab 是写死在 HTML 里的单个按钮，画板另一套代码，
所以画板能多开、对话只能一个。现在两者共用一套 `renderTabs`，
存储统一为 `chattool.tabs: [{kind,id}]` + `chattool.tab.active`。

画板是**与对话并列的一级视图**（详情见 `doc/feat/board-as-view.md`）：

```
☰  ChatTool  [搜索…]  ＋  ⋯  🌙  ⚙
💬 未命名会话 ×   🎨 论文 ×   🎨 复盘 ×   ＋
├ sidebar ┬── main（对话 或 画板）──┬ threadbar ┤
```

- 顶部 tab 始终显示**当前打开的对话与画板**，点即切换；`✕` 关掉某个画板 tab
- 左侧栏与右侧历史栏在画板视图下**依然可见**，不再被盖住
- 刷新后恢复上次的视图与已打开的画板
- 画板里按 `F` 或点「全屏」可临时全屏（Esc 退出）

> **割裂感的根源**：早期 `.boardview` 是 `position:fixed; inset:0; z-index:150`
> 的全屏遮罩，一打开就把对话、侧栏、历史栏全部盖掉。现在它只是 `#main` 里的
> 普通流内视图，与 `#detail` 用 `[hidden]` 互斥。
> `test_02` 断言 `.boardview` 不得再出现 `position:fixed + inset:0`。

消息底部「＋ 画板」→ 把内容搬上画布。

| 操作 | 方式 |
|---|---|
| 找画板 | 侧栏 **画板** tab（与「会话」并列），可搜索、可看节点数/所属文件夹 |
| 选目标画板 | 「＋ 画板」直接加入**上次用的画板**；菜单里「加入其他画板…」强制选其他 |
| 归类到项目 | 画板列表 ⋯ → 归类到文件夹（**多对多**，与会话一致） |
| 移动节点 | 直接拖拽（松开后保存坐标） |
| 调整大小 | 默认按内容推荐宽度；也可拖卡片**右下角**（双击手柄恢复默认） |
| 节点正文 | **Markdown 渲染**（与对话里同一套渲染器） |
| 写备注 | 点击节点顶部标题区直接输 |
| 颜色区分 | 节点工具里的「颜色」→ **点选预设色板** |
| 连线写关系 | 「连线模式」→ 点起点 → 点终点 → 输入关系词 |
| 改/删连线 | 点击连线本身，留空即删除 |
| 导出 | 顶栏「导出」，输出节点 + `A -->|关系| B` 列表 |

### 为什么这三件事以前不好用

| 现象 | 根因 | 修法 |
|---|---|---|
| 右侧找不到画板 | 侧栏只有 会话/文件夹/收藏/归档 四个 tab | 新增「画板」tab，复用同一套列表视觉 |
| 画板不能归类 | 只有 `conv_folder`，**没有 `board_folder`** | 新增多对多关联表 + `PUT /api/boards/{id}/folders` |
| 节点显示成纯文本 | `.bnode-text` 是 `${esc(content)}` | 改用 `MD.render`（不引入第三方库，见下） |
| 卡片尺寸/颜色靠手动猜 | 尺寸 CSS 写死 232px；颜色是「循环到下一个」 | 按内容推荐宽度 + 点选色板 |

**关于 Markdown 用库**：项目已有 `static/markdown.js`（手写，200 条断言覆盖，
含统一 escape）与 `app/markdown.py`（导出用）。画板节点内容就是消息内容，
两处**必须长得一致**，否则同一条消息在两个视图不同，是更严重的割裂；
加之项目「单页无构建」的约束，引入 marked/markdown-it 需打包或 CDN。
因此直接复用 `MD.render`。将来若要更完整语法，整体替换 Markdown 模块即可，
对话与画板会同时受益，而不是只给画板加一个库。

**宽度推荐**只在 `w == 0`（用户没拖过）时生效，且**写入数据库**——
否则刷新后又跳回默认值：短文本 232px / 长文或代码 320px / 表格或超长行 400px。
引用消息时正文不在 `content` 字段，会单独取 `message.content` 来算，
否则会永远得到 232px（这类边界有 `test_08` 锁定）。

#### 为什么要做「选画板」弹窗

早期用的是 `prompt("加入哪个画板？输入序号：1. x 2. y")`。三个问题：

1. 手机上 `prompt` 常被浏览器屏蔽 → 按钮点了没反应；
2. 让用户**数序号、记序号**，画板一多就容易选错；
3. **只有一个画板时会静默塞进去**，用户根本不知道加到了哪里。

现在是可点列表 + 当场新建 + 加入后 toast 明确告知「已加入「某某」」。
`test_73c` 锁住不得再回退到 prompt 输序号。

#### 卡片尺寸是怎么存的

`board_node` 新增 `w` / `h` 两列，**默认 0 = 用前端默认尺寸**。
只在用户真正拖过右下角时才写入具体数值——否则以后调整默认宽度时，
老节点会停在旧数值上。后端对尺寸做钳制（`w ∈ [120,900]`、`h ∈ [60,1200]`，
非正数归 0），前端拖拽时也钳一次，避免拖出负尺寸。
手调过尺寸的卡片（`.bnode.sized`）正文改为**内部滚动**而不是被 `-webkit-line-clamp` 截断，
否则拉大卡片也看不到更多内容。

旧库由 `_migrate_board_node_size()` 自动 `ALTER TABLE` 补列，已测过老节点数据不丢。
`test_73b` 锁住「存得住 / 改得动 / 越界钳制 / 0 可恢复默认」。

数据模型：一条消息可被**多个画板**引用；消息删除后节点保留并标记失效（`missing`），
不会因为清理会话而丢掉你画好的结构。

接口：`/api/boards`、`/api/boards/{id}/nodes`、`/api/boards/{id}/edges`。

### 分享收藏到 draw

上层的绘图软件 [`../draw`](../draw)（`node server.js`，默认 8090）是个画布型工具：
节点卡片 + 连线。ChatTool 的收藏可以直接流过去。

**链路**：收藏 → 导出 `mutiplechat-canvas` JSON → draw「⭐ 导入收藏」→ 卡片入库并可插入画布。

| 接口 | 作用 |
|---|---|
| `GET /api/favorites/draw` | 全部收藏打包成 draw 画布数据 |
| `POST /api/favorites/draw` `{ids:[...]}` | 只打包选中的收藏 |
| `GET /api/favorites/draw.json` | 同上，直接下载 `.json` 附件 |

**两种同步方式**

| 方式 | 操作 | 适用 |
|---|---|---|
| **直接同步**（推荐） | draw 里点「⭐ 同步收藏」或收藏面板「同步」 | 两台服务同机运行，一键、无文件 |
| 导出文件（兜底） | ChatTool「🎨 分享到 draw」→ draw「📁 导入收藏文件」 | draw 不在同机，或 ChatTool 没启动 |

draw 默认请求 `http://127.0.0.1:8765`。换端口/换机器时在 draw 控制台改一次：

```js
localStorage.setItem('chattool_url', 'http://192.168.1.5:8765')
```

**CORS 只开一条口子**

`FavoriteShareCors` 中间件只给 `/api/favorites/draw*` 加 CORS 头，且只放行本机来源
（`127.0.0.1` / `localhost` / `[::1]` 的任意端口）。

**没有做成全局 `allow_origins=['*']`**：`/api/settings`、`/api/llm/status` 这些接口能读写
API Key，全局放开等于让用户随便点开的恶意网页把自己的 Key fetch 走。当前哪怕从本机源
访问这些接口也不会带 CORS 头（`test_79` 锁定）。需要额外放行时用环境变量：

```bash
CHATTOOL_CORS_ORIGINS=http://192.168.1.5:8090 python3 -m app
```

draw 用 **GET 简单请求**（不带自定义头），浏览器不会发预检，少一个往返（`test_81` 锁定）。
同步失败一律静默 toast，不会弹窗打断——ChatTool 没启动不该让绘图变卡。

**格式契约**（与 draw 的 `exportCanvasData` 一致，两边共用同一份结构）：

```json
{ "format": "mutiplechat-canvas", "version": 1, "generator": "ChatTool",
  "view": {...}, "nodes": [...], "edges": [], "zones": [], "tasks": [],
  "draw_cards": [ { "nodeId": "n1", "messageId": "m_x", "convTitle": "...",
                    "role": "assistant", "tags": ["原理"], "source": "chattool" } ] }
```

- `nodes[*]` 的字段严格对齐 draw 的 `createNode`：`kind/title/x/y/w/h/text/src/prompt/zoneId/level`
- `draw_cards` 是给 draw 收藏库的元信息（消息 id、来源会话、标签）；`from = messageId`，
  因此**重复导入不会产生重复卡片**
- 卡片正文是带来源头的 Markdown（角色 / 来源会话 / 标签 / 收藏时间 + 原文）

`test_71`～`test_75` 锁定了这份契约，其中 `test_75` 会直接读 `../draw` 的源码，
校验字段名与 `draw_cards` 处理逻辑仍然存在——任一侧改了格式都会红。

## API Key 设置

点右上角 **⚙** 打开设置窗口：

- 切换供应商（Anthropic / OpenAI 兼容），填 **API Key / Base URL / 模型**
- **保存** — 留空表示不修改；保存后只回显 `********3456`
- **测试连接** — 向上游发一个 `max_tokens:1` 的极小请求，只返回成功/错误类别与状态码
- **设为当前** — 指定默认供应商；**清除** — 删除已存 Key

### 支持的供应商

| 供应商 | 协议 | 默认 Base URL | 默认模型 |
|---|---|---|---|
| **DeepSeek** | OpenAI 兼容 | `https://api.deepseek.com/v1` | `deepseek-chat` |
| **DeepSeek (Anthropic 兼容)** | Anthropic | `https://api.deepseek.com/anthropic` | `deepseek-chat` |
| Anthropic (Claude) | Anthropic | `https://api.anthropic.com` | `claude-sonnet-4-5` |
| OpenAI 兼容 | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |

DeepSeek 提供两种接入协议，这里两条都支持（`deepseek-reasoner` 也在模型建议里）。两者**共享同一个 Key**（`key_group` 机制）：在任一端点保存 Key，另一个自动可用；但 `base_url` 与 `model` 不跨界串用。

环境变量对应关系：

```bash
DEEPSEEK_API_KEY=sk-...              # DeepSeek 两种协议共用
DEEPSEEK_BASE_URL=...                # 可选，默认官方 /v1
DEEPSEEK_ANTHROPIC_BASE_URL=...      # 可选，默认官方 /anthropic
ANTHROPIC_AUTH_TOKEN=...             # 仅 Anthropic 条目用
OPENAI_API_KEY=...
```

> 注意：`ANTHROPIC_AUTH_TOKEN` 不会被当成 DeepSeek 的 Key（两者语义不同）。若你想用 DeepSeek 官方接口，请在 ⚙ 设置里填入 `DEEPSEEK_API_KEY` 或设该环境变量。

### 安全模型（重要）

1. **Key 永不返回前端**：`/api/llm/status` 只给 `configured`、`source`、`masked`（尾 4 位）。有测试 `test_12_llm_key_never_leaks` 逐接口断言返回体不含明文。
2. **Key 不进 Git**：存在 `data/chattool.db`，而 `data/` 在 `.gitignore` 里。
3. **环境变量优先**：检测到 `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` 时标记 `env_locked`，UI 修改不会覆盖部署环境。
4. **空值语义清晰**：不提交 `api_key` 字段 = 不改动；提交空串或 `clear_key:true` = 清除。

> ⚠️ **若你打算用 `--host 0.0.0.0` 让手机访问**：当前没有任何登录鉴权，局域网内任何人都能打开设置页使用你的 Key。务必只在本机/localhost 使用，或先加访问控制。

## 运行

```bash
python3 -m app --port 8765            # 默认 127.0.0.1
python3 -m app --host 0.0.0.0 --port 8765   # 局域网内手机访问
python3 -m app --reload                # 开发模式
```

依赖：`starlette`、`uvicorn`（Termux 下均已可用，无需 FastAPI/pydantic）。

数据默认落在 `data/chattool.db`，可用环境变量覆盖：

```bash
CHATTOOL_DATA=/path/to/data python3 -m app
```

## 测试

```bash
bash tests/run_all.sh                 # 全部
python3 -m tests.test_api             # 46 项 API（含对话/画板/提问/Key 安全）
python3 -m tests.test_markdown        # 9 项服务端 Markdown
node tests/markdown.test.js           # 前端 Markdown 渲染器（200 断言）
node tests/css_hidden.test.js         # CSS hidden 层叠检查
```

覆盖：会话 CRUD、多对多文件夹、分支生成与兄弟计数、收藏/标签、分享到 draw 的格式契约与 CORS 边界、级联删除、
四种导出、分享链接与撤销、JSON 往返导入、Pi 格式导入、搜索/统计/归档、
流式生成与分支上下文隔离、思考强度降级、右侧历史树、悬浮提问、
画板节点/连线/导出、API Key 不泄漏、启动契约与 CSS 层叠回归。

## 数据模型

```
conversation ─┬─< message (parent_id 自引用 → 消息树，分支 = 兄弟节点)
              │     └─ favorite / tags / meta
              ├─< conv_folder >─ folder (parent_id 自引用 → 文件夹树)
              └─ setting["share:<token>"] → 分享令牌

message >─< tag (message_tag)
```

关键设计：

- **分支不改写历史**：编辑消息时新建同 `parent_id` 的兄弟节点，原节点保留，`siblings()` 提供 `index/total` 供 UI 显示「2/3」切换器。
- **删除可回收**：删消息默认级联删整棵子树；`?cascade=0` 则把子节点上提到父级，避免树断裂。
- **前端「主线」**：取最新叶子的根到叶路径高亮，其余消息灰显为旁支，可一键展开全部。

## 用 Git 管理

仓库只跟踪源码与文档，**数据库与导出物不入库**（避免二进制冲突）：

```bash
git init && git add -A && git commit -m "ChatTool: 会话归类 / 分支 / 导出分享"
```

`.gitignore` 已排除 `data/`、`.run/`、`__pycache__`。

### 会话的版本历史（可选）

需要给**会话内容**做版本快照时，导出 JSON 存进仓库即可获得完整 diff 历史：

```bash
mkdir -p snapshots
curl -s "http://127.0.0.1:8765/api/conversations/$CID/export?format=json" > snapshots/$CID.json
git add snapshots && git commit -m "snapshot: $CID"
```

JSON 是纯文本且含 `parent_id`，Git diff 可读，也能随时 `POST /api/import` 回流重建。

## API 摘要

```
GET    /api/conversations?folder=&q=&archived=     列出会话（含文件夹与预览）
POST   /api/conversations                          新建（可带 folder_ids）
GET    /api/conversations/{id}                     详情 + messages + main_branch
PATCH  /api/conversations/{id}                     标题/摘要/归档
DELETE /api/conversations/{id}
PUT    /api/conversations/{id}/folders             整体设置归属文件夹
POST   /api/conversations/{id}/messages            追加消息（parent_id 可省）
POST   /api/conversations/{id}/generate           流式生成回复（SSE）
        body: {leaf_id?, provider?, model?, effort?, system?}
GET    /api/llm/options                            底部切换器的选项/档位
GET    /api/conversations/{id}/export?format=&branch_only=
POST   /api/conversations/{id}/share               生成分享令牌

PATCH  /api/messages/{id}                          content / favorite / tags / meta
DELETE /api/messages/{id}?cascade=0|1
POST   /api/messages/{id}/branch                   编辑为分支
GET    /api/messages/{id}/siblings                 分支位置
POST   /api/messages/{id}/tags  {name}
DELETE /api/messages/{id}/tags/{tag}

GET    /api/favorites?q=&tag=
GET    /api/tags
GET    /api/folders[?tree=1]   POST /api/folders
PATCH  /api/folders/{id}       DELETE /api/folders/{id}

POST   /api/import  {payload, format?: "pi", folder_ids?: []}
GET    /api/conversations/{id}/thread              消息树（右侧历史栏）
POST   /api/conversations/{id}/ask                 悬浮提问（SSE）
GET    /api/conversations/{id}/snippets            提问记录
DELETE /api/snippets/{id}

# 画板
GET|POST /api/boards                              列表 / 新建
GET|PATCH|DELETE /api/boards/{id}
GET    /api/boards/{id}/export                    导出 Markdown
POST   /api/boards/{id}/nodes                     加入消息作为节点
POST   /api/boards/{id}/edges                     连线 {from_node,to_node,label,style}
PATCH|DELETE /api/board-nodes/{id}                移动/备注/颜色/移除
PATCH|DELETE /api/board-edges/{id}                改关系名/删除

GET    /api/stats
GET    /s/{token}                                  公开只读分享页

# LLM 设置（Key 从不外发）
GET    /api/llm/status                             脱敏状态
PUT    /api/llm/config  {provider, api_key?, base_url?, model?, clear_key?}
DELETE /api/llm/config/{provider}                  清除 Key
PUT    /api/llm/active  {provider}                 设为当前
POST   /api/llm/test    {provider?}                连接测试
```

## 目录结构

```
app/
  db.py            SQLite 连接、schema、事务
  utils.py         ID / 时间 / JSON 响应
  conversations.py 会话与消息树（分支、收藏、兄弟节点）
  folders.py       文件夹多对多、标签
  settings.py      LLM 供应商 / API Key 脱敏存取
  llm.py           上游调用、协议适配、思考强度映射与降级
  generate.py      分支上下文构建、SSE 流式生成、自动命名、历史树、悬浮提问
  boards.py        画板节点/连线、悬浮提问记录
  markdown.py      服务端 Markdown 渲染（分享页 / HTML 导出）
  exporting.py     导出 / 分享 / 导入（含 Pi 解析）
  routes.py        Starlette 路由
  main.py          入口
frontend/index.html
static/style.css  static/app.js  static/markdown.js  static/panels.js
tests/test_api.py  tests/test_markdown.py  tests/markdown.test.js
```
