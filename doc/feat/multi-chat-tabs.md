# 多对话 tab（multi-chat-tabs）

## 1. 背景

`doc/feat/board-as-view.md` 让画板成了可多开的一级视图，但对话侧仍是**写死的单 tab**：

```html
<button data-viewtab="chat">💬 <span id="vtab-chat-title">对话</span></button>
```

问题：

1. **不对称**：画板能开多个 tab，对话只能开一个，用户会困惑为什么。
2. **切换成本高**：在两个会话之间来回看，要走「侧栏 → 找会话 → 点开」，每次丢失阅读位置。
3. **两套代码**：画板 tab 用 `data-boardtab` + 一套渲染，对话 tab 是静态 HTML，逻辑分叉。

## 2. 设计目标与边界

**做「同时打开多个不同会话」**（需求 A）。

**不做「同一会话开多个位置」**（需求 B）。原因：

- `state.activeConv` 是单例，同一个会话开两个 tab 必须做"两个视图共享一份数据"的同步，
  否则 A tab 改完 B tab 还显示旧内容——这是**数据正确性问题**，不是 UI 问题。
- 真正需求（长对话翻上去看，回来找不到位置）用**滚动位置记忆**解决，
  零同步风险，代码量差一个数量级。

所以本方案的关键取舍：**tab = 最近打开的会话列表 + 每个会话的阅读锚点**，
切换 tab 仍是「打开那个会话」，但**回到你上次看的位置**。

## 3. 统一 tab 模型

现在有两套 tab（对话 / 画板），合并成一套：

```js
// 统一条目
{ kind: "chat"|"board", id: string, title: string }
```

存储：

| 键 | 内容 |
|---|---|
| `chattool.tabs` | `[{kind,id}]` 有序数组（去重） |
| `chattool.tab.active` | `{kind,id}` 当前项 |
| `chattool.scroll.<convId>` | 该会话的滚动位置（`scrollTop` + 锚点消息 id） |

**为什么用 `{kind,id}` 而不是只存 id**：会话 id 是 `c_xxx`、画板是 `b_xxx`，前缀能区分，
但显式存 `kind` 让渲染逻辑不用靠前缀猜，也便于以后加第三种 tab（如"分享页预览"）。

## 4. 行为规格

| 操作 | 行为 |
|---|---|
| 点侧栏会话 | 若已在该 tab 列表 → 切过去（不新增）；否则新增 tab 并切换 |
| 点 `＋` | 弹出列表（会话 + 画板，复用搜索框过滤），选中即打开 |
| 点 tab | 切到该项；会话恢复到上次滚动位置 |
| 点 tab 的 `✕` | 关闭；若关的是当前项 → 切到相邻项；没有则新建一个空会话 |
| 关闭「当前唯一对话 tab」 | **不留空**：自动打开一个新会话（保证"永远能说话"） |
| 删除会话 | 对应 tab 从列表移除；若是当前项 → 切相邻 |
| 刷新 | 恢复 `chattool.tabs` 与当前项；会话本身重新拉取 |

**不设 tab 上限**：用户自己会关。scroll 容器横向滚动。

## 5. 滚动位置记忆

```js
// 切走前
saveScroll(convId)  // 记 scrollTop + 当前最靠上的可见消息 id
// 切回来（openConv 渲染完消息之后）
restoreScroll(convId) // 有锚点消息就 scrollIntoView(block:"start")，否则用 scrollTop
```

用**锚点消息 id** 而不是纯 `scrollTop`：消息渲染后高度可能变化（图片、Markdown 表格），
纯像素值会飘；锚点能稳稳停在同一条消息上。

存内存 `Map` 即可，**不落库**——跨刷新保持滚动位置价值不大，还会让"打开会话就在中间"显得怪。
但同一会话在 tab 间来回切要保留，所以放内存。

## 6. 实现要点（简洁的地方）

1. **tab 渲染只保留一份**：删掉静态的 `data-viewtab="chat"` 按钮，
   全部由 `renderTabs()` 动态生成。
2. **复用 `openConv`**：切 tab 就是调 `openConv(id)`，不新建渲染路径。
3. **复用画板已有的去重/回落逻辑**：`openBoardTab` / `closeBoardTab` 的形态直接套用到 chat。
4. **`＋` 菜单复用** `#global-search` 的过滤结果与 `#modal-pick-board` 的形态，
   扩成「会话 + 画板」两段。

## 7. 坑

| 坑 | 处理 |
|---|---|
| 关闭当前对话 tab 后界面空白 | 不留空，自动开新会话（沿用 `ensureConversation` 的契约） |
| 会话标题改了 tab 不更新 | `openConv` 末尾已调 `renderTabs`，确保路径都走它 |
| tab 指向已删除的会话 | `renderTabs` 时用本地 `state.convs` 校验，失效项剔除 |
| 关闭 tab 时 `activeConv` 已不是它 | 只有当关的是当前项才切走，否则只移除列表项 |
| 滚动恢复与流式生成冲突 | 生成中不恢复（用户正在看新内容） |

## 8. 测试

`tests/test_chat_tabs.py`：

1. 不再有静态 `data-viewtab="chat"` 按钮（改为动态渲染）
2. 存在统一 tab 存储键 `chattool.tabs` / `chattool.tab.active`
3. 同一会话重复打开不产生重复 tab（去重）
4. 关闭当前对话 tab 不会让界面空着（回落到相邻或新建）
5. 滚动位置记忆存在（`chattool.scroll.<id>` 或内存 Map + 锚点消息）
6. 打开会话后必须调 `renderTabs`（标题同步）
7. 画板 tab 与对话 tab 共用同一套渲染函数（不得保留两套）
