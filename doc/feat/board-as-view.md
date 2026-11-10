# 画板提升为一级视图（board-as-view）

## 1. 背景

画板（`#boardview`）当前是一个 **全屏遮罩**：

```css
.boardview { position: fixed; inset: 0; z-index: 150; }
```

它挂在 `<body>` 下，与 `.layout`（侧栏 / 对话 / 历史栏）平级。
打开画板 = 把整个对话界面盖住。由此产生的割裂：

1. **物理隔离**：在画板里看不到任何对话，想参考某条消息必须关掉画板。
2. **入口深**：`＋ 画板` 藏在消息脚 `⋯` 菜单第 4 项；画板本身在顶栏 `⋯` 菜单里。
3. **不是一个"地方"**：它是浮层，没有 tab、没有面包屑，用户不知道自己在哪、怎么回去。
4. **不记忆**：`loadBoards()` 每次 `keep ? state.board.id : state.boards[0].id`，
   关闭再打开跳回第一块，`grep chattool.board` 无任何持久化。

目标：把**画板提升为与「对话」同级的一级视图**，顶部用 tab 切换，
当前打开的对话与画板始终显示在 tab 上。

## 2. 设计

### 2.1 视图模型

引入一级视图 `view ∈ {chat, board}`，由主区的 tab 条切换：

```
┌──────────────────────────────────────────────┐
│ ☰  ChatTool  [搜索…]  ＋  ⋯  🌙  ⚙          │  topbar
├──────────────────────────────────────────────┤
│ 💬 未命名会话 ×   🎨 论文 ×   ＋             │  viewtabs  ← 新增
├────────┬─────────────────────────┬───────────┤
│ sidebar│ main (chat 或 board)    │ threadbar │
└────────┴─────────────────────────┴───────────┘
```

- **对话 tab**：显示当前会话标题；始终存在。
- **画板 tab**：每打开过一块画板就多一个 tab（可关闭）；同一块画板不重复。
- tab 上的 `×` 关闭该 tab；关闭当前 tab 时回落到 `chat`。
- `view` 与已打开的 tab 列表存 `localStorage`，刷新后恢复。

### 2.2 关键改动：画板不再是遮罩

```css
/* 旧 */
.boardview { position: fixed; inset: 0; z-index: 150; }

/* 新：普通流内视图，与 .detail 同级互斥显示 */
.boardview { flex: 1; min-height: 0; display: flex; flex-direction: column; }
```

`.boardview` 从 `<body>` 下搬到 `#main` 内，与 `#detail` 并列，
用 `[hidden]` 互斥。这样：
- 左侧栏、右侧历史栏**依然可见**，画板不再盖全场；
- 画布的可用宽度由 `.main` 决定，与对话一致；
- 全屏按钮保留为可选增强（`F` 键 / 顶栏按钮切换 `fullscreen` 类）。

> ⚠️ 保留 `[hidden] { display: none !important }` 全局兜底不变；
> `tests/css_hidden.test.js` 会继续检查 `.boardview` 带 `hidden` 时不显示。

### 2.3 记忆与恢复

| 键 | 内容 |
|---|---|
| `chattool.view` | `"chat"` \| `"board"` |
| `chattool.board.open` | 已打开画板 id 数组（有序） |
| `chattool.board.active` | 当前画板 id |

`switchBoard(id)`：先落盘当前画板，再切（照抄 MutipleChat `multi-canvas.md` §2.3 的
「先 flush 再切换」，避免切换瞬间丢编辑）。

### 2.4 「加入画板」不再每次弹窗

当前 `pickBoard()` 每次都弹窗，连加 10 条要弹 10 次。改为：

1. 有 `chattool.board.active` → **直接加入该画板**，toast「已加入「论文」」；
2. 无记忆 → 弹窗选择（保留上一轮的 `#modal-pick-board`）；
3. 消息脚菜单额外提供 **「加入其他画板…」** 强制弹窗。

首次使用必须弹窗，因为此时没有任何记忆，不能猜。

### 2.5 边界情况

| 情况 | 处理 |
|---|---|
| 关闭当前画板 tab | 回落到左边相邻 tab，没有则回 `chat` |
| 删除当前画板 | 从 tab 列表移除，切到剩余第一块；没有则回 `chat` |
| 画板 id 已不存在（另一设备删了） | 打开时跳过并清理该 tab |
| 已打开 tab 再次「加入」 | tab 不重复，只切换过去 |
| 无任何画板 | 画板视图显示空态引导 + 「新建」 |

## 3. 接口

前端不需要新接口，复用：

| 接口 | 用途 |
|---|---|
| `GET /api/boards` | 画板清单 |
| `GET /api/boards/{id}` | 单画板（含节点/连线） |
| `POST /api/boards/{id}/nodes` | 加入节点（已有 `w/h`） |

## 4. 影响面

- `#boardview` 从 `body` 移入 `#main`；`.boardview` 样式由 fixed 改为流内。
- `topbar ⋯` 里的「画板」改为「打开画板视图」。
- `Board.open()` / `Board.close()` 语义改为切视图，不再是显隐遮罩。
- 新增 `tests/test_board_view.py` 锁定：
  1. `#boardview` 必须位于 `#main` 内（不再是 body 直下）；
  2. `.boardview` 不得再有 `position:fixed` + `inset:0`（否则又变遮罩）；
  3. tab 条 `#viewtabs` 存在且含对话 tab；
  4. `chattool.board.active` 键存在（记忆上次画板）；
  5. 已打开画板 tab 去重。

## 5. 实现与校验结果

**已落地**：

- `#boardview` 已在 `#main` 内，与 `#detail` 同级，用 `[hidden]` 互斥；
- `.boardview` 改为 `flex: 1; min-height: 0; display: flex` 流内布局，
  不再有 `position: fixed` / `inset: 0` / `z-index`；
- 新增 `#viewtabs` 一级 tab 条（对话 + 多个画板 tab）；
- `chattool.view` / `chattool.board.open` / `chattool.board.active` 持久化，
  刷新后恢复上次视图与已打开画板；
- 全屏保留为可选增强（`F` 键 / 顶栏按钮 → `.boardview.fullscreen`，Esc 退出）。

**校验**：

```bash
.venv/bin/python -m tests.test_board_view      # 10 tests OK
```

**坑**：遮罩形态最容易被改回去——只要有人给 `.boardview` 加回
`position: fixed; inset: 0`，`test_02` 立刻报错。这条断言是这份设计的护栏。
