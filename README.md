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
python3 -m tests.test_api
```

覆盖：会话 CRUD、多对多文件夹、分支生成与兄弟计数、收藏/标签、级联删除、四种导出、分享链接与撤销、JSON 往返导入、Pi 格式导入、搜索/统计/归档、静态资源。

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
GET    /api/stats
GET    /s/{token}                                  公开只读分享页
```

## 目录结构

```
app/
  db.py            SQLite 连接、schema、事务
  utils.py         ID / 时间 / JSON 响应
  conversations.py 会话与消息树（分支、收藏、兄弟节点）
  folders.py       文件夹多对多、标签
  exporting.py     导出 / 分享 / 导入（含 Pi 解析）
  routes.py        Starlette 路由
  main.py          入口
frontend/index.html
static/style.css  static/app.js
tests/test_api.py
```
