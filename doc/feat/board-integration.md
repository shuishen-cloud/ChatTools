# 画板融入系统（board-integration）

承接 `board-as-view.md`（画板已升为一级视图）。本文解决剩下的四处「画板像外挂」：

| # | 问题 | 现状 | 目标 |
|---|---|---|---|
| 1 | 侧栏没有画板列表 | 侧栏 4 tab：会话/文件夹/收藏/归档 | 新增「画板」tab |
| 2 | 画板不能归类到项目 | 仅有 `conv_folder` | 新增 `board_folder`，多对多 |
| 3 | 节点不渲染 Markdown | `${esc(n.content)}` | 复用 `MD.render` |
| 4 | 尺寸/颜色要手动挑 | 尺寸=CSS 写死；颜色循环猜 | 内容自适应尺寸 + 预设色板 |

## 1. 侧栏画板列表

新增第 5 个 tab `data-view="boards"`，与「会话」一致的结构：

- 列表项显示：名称、节点数、所属文件夹 chip
- 点击 → `Board.openBoardTab(id)`（进一级视图，不弹窗）
- 头部 `＋ 新建`
- 支持搜索过滤（复用 `#global-search` 的值）

不新增接口：`GET /api/boards` 已返回 `node_count` / `edge_count`，
本次追加 `folders` 字段（见 §2）。

## 2. 画板归类到文件夹（多对多）

### 2.1 数据模型

照抄 `conv_folder` 的形态：

```sql
CREATE TABLE IF NOT EXISTS board_folder (
    board_id  TEXT NOT NULL REFERENCES board(id)  ON DELETE CASCADE,
    folder_id TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
    PRIMARY KEY (board_id, folder_id)
);
```

**为什么不给 `board` 加 `folder_id` 外键**：文件夹本身支持嵌套且会话已是多对多
（一个会话同时属于「论文」+「本周复盘」），画板没有理由退化成单亲。
同一套 `folders` 表服务两种对象，用户心智一致。

### 2.2 接口

| 接口 | 语义 |
|---|---|
| `PUT /api/boards/{id}/folders` `{folder_ids:[...]}` | 全量替换（与会话一致） |
| `GET /api/boards` | 每项追加 `folders: [{id,name,color}]` |
| `GET /api/folders` | 追加 `board_count` |

复用现有 `folder_picker` 弹窗（`#modal-folders`），把「当前对象」从
`state.activeConv` 泛化为 `{kind: "conv"|"board", id}`。

## 3. 节点内容 Markdown 渲染

`.bnode-text` 由 `esc()` 改为 `MD.render()`。

### 3.1 为什么要用库

现有 `static/markdown.js` 是**手写的 236 行渲染器**，覆盖：代码块、表格、任务列表、
引用、列表、行内样式、图片。它已被 `tests/markdown.test.js`（200 断言）覆盖，
且服务端另有 `app/markdown.py`（导出用）。

结论：**不引入第三方库**，直接复用 `MD.render`。理由：

1. 已有实现经过 200 条断言，含 XSS 转义（`inline()` 统一 escape）；
2. 画板节点内容就是消息内容，与对话里渲染**必须一致**，否则同一条消息
   在两处长得不一样，是更严重的割裂；
3. 引入 marked/markdown-it 需要打包或 CDN，违背本项目「单页无构建」的约束；
4. 两份渲染器并存必然逐渐分叉。

> 若将来需要更完整语法（脚注、数学公式），再整体替换 `Markdown` 模块，
> 对话与画板会同时受益——而不是只给画板加一个库。

### 3.2 安全

`MD.render` 内部对文本统一 escape，代码块走 `renderCode` 单独转义。
画板节点复用同一路径，不额外拼接未转义内容。

### 3.3 样式

`.bnode-text` 内的 `pre` / `table` / `blockquote` 需要约束宽度，
避免撑破 232px 的卡片：

```css
.bnode-text pre, .bnode-text .table-wrap { max-width: 100%; overflow-x: auto; }
.bnode-text img { max-width: 100%; }
```

## 4. 尺寸与颜色不再靠手动挑

### 4.1 尺寸：内容自适应 + 手动覆盖

当前：`w/h = 0` → CSS 写死 `width: 232px`，所有卡片一样宽，长内容被截断。

改为三级优先：

1. 用户拖过右下角 → 用 `w/h`（已有，不动）；
2. 未拖过 → **按内容估算初始宽度**：
   - 纯短文本（< 40 字）→ 232px
   - 长文本 / 含代码块/表格 → 320px
   - 含宽表格 → 400px
3. 高度默认 `auto`（CSS），不再固定。

实现：`add_node` 时若未显式传 `w`，后端按 `content` 长度与特征给一个建议值并落库
（**写入数据库**而不是只在前端算，否则刷新后跳回 232）。

> 为什么在后端算：`GET /api/boards/{id}` 返回的就是要渲染的尺寸，
> 前端无需二次计算；且导出（`/export`）也拿到同样的值。

### 4.2 颜色：预设色板，不再循环猜

当前「颜色」按钮是**循环切换**：`colors.indexOf(n.color)` → 下一个。
用户点 3 次才能到想要的色，且不知道下一个是什么。

改为：点击「颜色」弹出 5 色小面板（`#bnode-palette`），点哪个是哪个。
颜色取自主题变量族（`--acc` / `--green` / `--gold` / `--red` / 紫），
与文件夹 chip 用同一套色，视觉统一。

## 5. 边界与坑

| 情况 | 处理 |
|---|---|
| 删除文件夹 | `board_folder` 级联清理，画板本体不受影响 |
| 画板内容含裸 HTML | `MD.render` 统一 escape，不执行 |
| 超长单行（URL） | `.bnode-text` 已有 `word-break: break-word` |
| 后端建议宽度 | 只在 `w == 0` 时生效，用户拖过的不覆盖 |
| 画板名重复 | 允许（id 主键） |

## 6. 测试

`tests/test_board_integration.py`：

1. `board_folder` 多对多：一个画板入两个文件夹、查询返回两个
2. `PUT /api/boards/{id}/folders` 全量替换语义
3. 删除文件夹后画板仍在且关联清理
4. `GET /api/boards` 每项含 `folders` 与 `node_count`
5. 尺寸建议：长内容新建时 `w > 232`；短内容 `w == 232`
6. 显式传 `w` 时不被建议值覆盖
7. 前端：`sidebarb` tab 存在；`.bnode-text` 走 `MD.render` 而非 `esc`
8. 前端：颜色面板存在（`bnode-palette`），不再只有循环逻辑

## 7. 实现与校验结果

**已落地**：

- `board_folder` 多对多表 + `PUT/GET /api/boards/{id}/folders`，
  与 `conv_folder` 完全同语义（全量替换）；
- `board_node` 新增 `w` / `h`（默认 0 = 前端默认尺寸），
  `_migrate_board_node_size()` 给旧库自动补列；
- `recommend_width()` 按内容特征给建议值（短 232 / 长文或代码 320 / 表格超长行 400），
  **只在 `w == 0` 时生效并落库**；
- `_clamp_size()` 钳制 `w ∈ [120,900]`、`h ∈ [60,1200]`，非正数归 0；
- `.bnode-text` 改用 `MD.render`，与对话共用同一渲染器；
- 侧栏第 5 个 tab「画板」；`#modal-pick-board` 取代 `prompt` 输序号；颜色改预设色板。

**校验**：

```bash
.venv/bin/python -m tests.test_board_integration   # 12 tests OK
.venv/bin/python -m tests.test_api                 # 86 tests OK
```

**坑（已记笔记）**：

| 坑 | 说明 |
|---|---|
| 引用消息时 `content` 为空 | `add_node` 的 `message_id` 分支正文从 `message` 表取，直接拿 `content` 算宽度会永远得到 232px，需单独取 `message.content` |
| 0 不等于无效 | `w=0` 是「用户没拖过」的合法语义，不能被当成无意义值丢掉 |
| 单独给画板引 Markdown 库 | 会让同一条消息在对话与画板长得不一样；复用 `MD.render` 才能保证一致 |
