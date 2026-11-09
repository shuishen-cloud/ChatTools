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
| **移动优先** | 单页无构建、响应式；Termux / 手机浏览器可用 |
| **API Key 设置** | 右上角 ⚙ 打开设置，支持 **DeepSeek** / Anthropic / OpenAI 兼容；存服务端、只回显尾 4 位；可测连接 |
| **真对话生成** | 底部输入框发送后**流式请求 AI 回复**并落库；可中途停止；失败会记录错误而非丢消息 |
| **服务商 / 模型 / 思考强度切换** | 聊天框底部三个下拉：服务商、模型、思考档位（关/低/中/高），选择本地记忆 |
| **推理过程可见** | 支持推理的模型会流式显示「思考过程」，与正文分开保存 |
| **分支感知上下文** | 生成时只把当前分支的祖先链发给模型，兄弟分支互不污染 |
| **右侧历史快速切换** | 右栏把消息树渲染成脉络，与滚动双向联动，可折叠分支、一键跳转 |
| **悬浮提问窗** | 选中任何文字浮现「💬 就此提问」，弹出**可拖动的悬浮窗**；回答可一键加入画板 |
| **提示词画板** | 把任意会话的消息「＋ 画板」，在画布上拖拽布局、连线写出关系，可导出 Markdown |

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
- 顶栏「历史」按钮开关；桌面默认展开，手机默认收起（抽屉式）
- `.main` 设了 `min-width: 0`，否则长内容会把右栏挤出视口

接口：`GET /api/conversations/{id}/thread` → 递归树 + `main_branch`。

### 悬浮提问窗

在消息里**选中任意文字** → 浮出「💬 就此提问」→ **可拖动的悬浮窗**流式回答。

- 窗口可拖动（拖标题栏）、可缩放（右下角），不会挡住你正在看的内容
- 左上「＋ 画板」把「引文 + 问题 + 回答」打包成一条消息直接加入画板
- 顶栏「提问记录」可回看该会话所有悬浮问答

- 回答存入 `snippet_qa` 表，**不写入消息树**，所以不会弄乱对话主线
- 顶部「提问记录」可回看该会话的所有悬浮问答
- 没选中文本时，消息底部的「💬 提问」按钮会用整条消息当引文
- 提问走独立 system prompt（不复述引文、信息不足时明确指出）

### 提示词画板

消息底部「＋ 画板」→ 把内容搬上画布。

| 操作 | 方式 |
|---|---|
| 移动节点 | 直接拖拽（松开后保存坐标） |
| 写备注 | 点击节点顶部标题区直接输 |
| 颜色区分 | 节点工具里的「颜色」循环切换 |
| 连线写关系 | 「连线模式」→ 点起点 → 点终点 → 输入关系词 |
| 改/删连线 | 点击连线本身，留空即删除 |
| 导出 | 顶栏「导出」，输出节点 + `A -->|关系| B` 列表 |

数据模型：一条消息可被**多个画板**引用；消息删除后节点保留并标记失效（`missing`），
不会因为清理会话而丢掉你画好的结构。

接口：`/api/boards`、`/api/boards/{id}/nodes`、`/api/boards/{id}/edges`。

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

覆盖：会话 CRUD、多对多文件夹、分支生成与兄弟计数、收藏/标签、级联删除、
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
