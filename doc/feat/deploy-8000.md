# 部署到服务器的 /8000 子路径（deploy-8000）

## 1. 背景

ChatTool 原本只在本机 `127.0.0.1:8765` 跑。现在要求：

1. **部署到已有服务器**（Docker 已在跑 MutipleChat），可通过手机访问；
2. **挂在 Nginx 的 `/8000` 子路径**下；
3. 服务器为**唯一真源**，本地库一次性迁上去，之后本机不再长期跑；
4. 更新流程保持「本地 commit → push → 服务器 pull → 重建容器」。

### 为什么不能直接 `--host 0.0.0.0`

`data/chattool.db` 里存着 LLM API Key（`settings.py` 的设计原则是「只存服务端」）。
裸端口暴露公网 = 任何扫描器都能调用 `/api/generate` 烧 Key、读全部会话。
README 第 447 行已写明该风险。因此**必须**：

- 容器端口只绑 `127.0.0.1`（`ports: ["127.0.0.1:8765:8765"]`）；
- 公网流量一律过 Nginx，且 Nginx 层加 Basic Auth。

## 2. 现状盘点：子路径会破坏什么

前端所有 API 调用都经过 `static/app.js:40` 的 `api()` 单点封装，
这是本次改造能收敛的前提。逐处核对绝对路径：

| 位置 | 内容 | 子路径下是否坏 |
|---|---|---|
| `app.js:40` | `api()` → `fetch(path)` | **坏**（所有 API 都经此） |
| `app.js:689` | `fetch('/api/.../generate')` SSE 流 | **坏** |
| `app.js:919` | `download()` 里的 `a.href = /api/.../export` | **坏** |
| `app.js:911` | `location.origin + info.url`（分享链接） | **坏**（`info.url` 是 `/s/<token>`） |
| `panels.js:453` | `fetch(endpoint)`（提问流式） | **坏**（endpoint 由调用方传绝对路径） |
| `index.html:7,287-290` | `/static/...` 的 css/js 引用 | **坏** |
| `exporting.py:189` | 返回 `url: /s/<token>` | **坏**（前端拼接时缺前缀） |

服务端本身**不需要改**：Nginx 用 `proxy_pass http://127.0.0.1:8765/;`（尾部斜杠）
把 `/8000/xxx` 改写成 `/xxx`，Starlette 的路由表原样匹配即可。

### 关键设计：前缀从哪来

不能写死 `'/8000'`——本机开发时没有前缀，且将来可能换路径。
必须在**运行时从 `location.pathname` 推断**，并且兼容两种写法：

- 部署在子路径：`location.pathname === '/8000/...'` → 前缀 `/8000`
- 本机根路径：`location.pathname === '/'` → 前缀 `''`
- 子路径下的深层 URL：`/8000/s/abc` → 前缀仍是 `/8000`

推断规则：取路径的**第一段**，若该段匹配 `^[A-Za-z0-9_-]+$` 且不是已知的
根级页面（空），就当前缀。更稳妥的做法是让服务端把前缀**注入**页面，
但会增加一次改动面；这里采用注入，理由见 2.1。

### 2.1 采用「服务端注入前缀」而不是「前端猜测」

猜测法在 `/8000/s/<token>` 这类深层路径上是对的（第一段仍是 8000），
但一旦将来部署到 `/tools/chattool/` 这种**多级**路径就失效。
而服务端本来就在渲染 `index.html`（`routes.py:index` 返回 `FileResponse`），
Nginx 又把完整原始路径通过 `X-Forwarded-Prefix` 或 `Host`+`X-Original-URI` 传来。

两条注入路线，选更简单可靠的：

**A. 环境变量 `CHATTOOL_PREFIX`**（推荐）
- 服务端读环境变量，渲染 index.html 时把 `__PREFIX__` 占位符替换掉；
- compose 里写 `CHATTOOL_PREFIX=/8000`，换路径只改配置不改代码；
- 本机不设该变量 → 前缀为空串，行为与现在完全一致。

**B. 读 `X-Forwarded-Prefix` 头**
- Nginx 加一行 `proxy_set_header X-Forwarded-Prefix /8000;`
- 无需占位符替换，但分享页 `/s/<token>` 是独立 HTML（不经星标渲染），仍需处理。

选 **A**，因为分享页与导出下载也要拿到前缀，环境变量在进程内全局可见，
一次读取处处可用，不依赖请求头是否被代理透传。

### 2.2 前缀如何到达前端

`index()` 现在直接 `FileResponse(FRONTEND / "index.html")`。改为：

1. 读取文件文本；
2. 把 `<script>` 前的 `<head>` 里插入
   `<script>window.__CT_PREFIX = "{{PREFIX}}";</script>`；
3. 把 `/static/...` 引用改写成 `{{PREFIX}}/static/...`（或干脆让前端
   用 `__CT_PREFIX` 拼——但 css 是 `<link>`，必须在 HTML 里替换）。

具体：HTML 里写占位符 `%%PREFIX%%`：

```html
<link rel="stylesheet" href="%%PREFIX%%/static/style.css">
<script src="%%PREFIX%%/static/app.js"></script>
<script>window.__CT_PREFIX = "%%PREFIX%%";</script>
```

`index()` 里 `text.replace("%%PREFIX%%", PREFIX)`。
`PREFIX` 为空串时得到 `/static/style.css`，与本机现状**逐字节一致**。

### 2.3 前端拼前缀

`app.js` 顶部：

```js
const PREFIX = window.__CT_PREFIX || "";
const withPrefix = (p) => (p.startsWith("/") ? PREFIX + p : p);
```

改 5 处：

```js
// api()
const res = await fetch(withPrefix(path), { ... });

// generate SSE
await fetch(withPrefix(`/api/conversations/${conv.id}/generate`), ...)

// download()
const url = withPrefix(`/api/conversations/${...}/export?...`);

// 分享链接
const full = location.origin + withPrefix(info.url);

// panels.js 的 fetch(endpoint) → fetch(withPrefix(endpoint))
//   但 panels.js 是独立文件，拿不到 app.js 的局部变量。
//   → 把 withPrefix 挂到 window 上：window.__ctWithPrefix
```

`panels.js` 在 `app.js` 之前加载（`index.html:289-290`），
但 `panels.js` 里的 fetch 都在事件回调里执行，此时 `app.js` 已加载完毕，
故可以安全地在调用时读 `window.__ctWithPrefix`。

### 2.4 分享链接与只读页

`exporting.py:create_share` 返回 `url: "/s/<token>"`（不带前缀）。
若在服务端拼前缀，库里存的值就与部署路径绑定了——将来换路径，旧分享链接全坏。

**决策：库里仍存无前缀的 `/s/<token>`，前缀由前端拼接**（见 2.3 第 4 条）。
服务端路由 `/s/{token}` 由 Nginx 改写后正常命中，不需要感知前缀。

## 3. 交付物

### 3.1 新增文件

| 文件 | 作用 |
|---|---|
| `Dockerfile` | python:3.13-slim + starlette/uvicorn |
| `requirements.txt` | `starlette==1.10.0` / `uvicorn==0.54.0`（与 .venv 实测版本一致） |
| `.dockerignore` | 排除 `.venv/` `data/` `.git/` `tests/` `doc/` `.pdm/` |

### 3.2 代码改动

| 文件 | 改动 |
|---|---|
| `app/routes.py` | 读 `CHATTOOL_PREFIX`；`index()` 做占位符替换 |
| `frontend/index.html` | 4 处 `/static/` 加 `%%PREFIX%%`；注入 `window.__CT_PREFIX` |
| `static/app.js` | 顶部加 `PREFIX`/`withPrefix`；改 4 处调用；挂 `window.__ctWithPrefix` |
| `static/panels.js` | 1 处 `fetch(endpoint)` → `fetch(window.__ctWithPrefix(endpoint))` |

**不做**：服务端路由加前缀（Nginx 改写足够）；数据库加前缀（见 2.4）。

### 3.3 服务器侧（不进仓库）

- `docker-compose.yml`：chattool 服务，端口绑 `127.0.0.1:8765`，卷挂 `./data/chattool`；
- Nginx `location /8000/`：`proxy_pass http://127.0.0.1:8765/;`（**尾部斜杠必须成对**）、
  `proxy_buffering off;`（SSE 流式生成必需，否则手机上表现为卡死）、
  `proxy_read_timeout 300s;`、Basic Auth。

## 4. 数据迁移

本地 `data/chattool.db` 是 WAL 模式，**不能直接 `scp` 主库**
（`-wal` 里可能有未合并的事务）。用 SQLite 的一致性备份：

```bash
sqlite3 data/chattool.db ".backup /tmp/chattool-clean.db"
scp /tmp/chattool-clean.db 服务器:~/apps/data/chattool/chattool.db
```

迁移后本机库**保留不动**（作为回滚点），但本机不再作为日常数据源。

## 5. 验收清单

| # | 场景 | 期望 |
|---|---|---|
| 1 | 本机不设 `CHATTOOL_PREFIX` 跑测试 | `run_all.sh` 全绿，index.html 输出与本改动前一致 |
| 2 | 设 `CHATTOOL_PREFIX=/8000`，GET `/` | HTML 里所有 `/static/` 均带 `/8000` 前缀 |
| 3 | 同上，无残留 `%%PREFIX%%` | 断言 `'%%PREFIX%%' not in html` |
| 4 | 子路径下打开页面 | 会话列表、发消息流式、导出、分享均正常 |
| 5 | 分享链接 | 形如 `https://域名/8000/s/<token>`，点开可读 |
| 6 | 裸端口 `127.0.0.1:8765` 外网不可达 | `curl` 超时 |
| 7 | 未带 Basic Auth 访问 | 401 |

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| `proxy_pass` 尾斜杠写错 → 404 | 验收 #2/#4 直接暴露 |
| SSE 被 Nginx 缓冲 → 手机"卡死" | `proxy_buffering off`，验收 #4 |
| 前缀替换漏了某个静态引用 → 白屏 | 验收 #3 断言无占位符残留 |
| 数据迁移时库损坏 | 用 `.backup` 而非 `cp`；保留本地库回滚 |

回滚：`docker compose down`，本地库仍在，`python -m app` 照常跑。

## 7. 不做什么

- **不做多用户/鉴权改造**：单用户，Basic Auth 在 Nginx 层足够。
- **不做本地↔服务器双向同步**：SQLite WAL 双向同步会损坏，服务器为唯一真源。
- **不改 MutipleChat 的 `CHATTOOL_DRAW_URL`**：同源部署后 `/8000/api/favorites/draw`
  可达，但该地址需在 MutipleChat 侧另开一张票处理（本票只负责 ChatTool 上线）。

---

## 8. 实现与校验结果

### 8.1 实测通过的验收项

在本地以 `CHATTOOL_PREFIX=/8000` 启动（`python -m app --port 18765`），实测：

```
GET /            -> <link href="/8000/static/style.css">
                    <script>window.__CT_PREFIX = "/8000";</script>
                    <script src="/8000/static/app.js">
GET /api/stats   -> {"ok":true,...}          （应用侧仍只认 /api/*）
GET /static/app.js -> 200
GET /8000/static/app.js -> 404               （前缀由 Nginx 剥离，有意为之）
```

| 验收 # | 结果 |
|---|---|
| 1 本机不设前缀，行为不变 | ✅ `test_01_no_prefix_keeps_root_paths`，且全量 140 项 unittest 通过 |
| 2 设 /8000 后静态引用全带前缀 | ✅ `test_02_prefix_rewrites_all_static_refs` |
| 3 无 `%%PREFIX%%` 残留 | ✅ `test_02` 内断言 |
| 4 子路径下功能正常 | ✅ 见 8.1 实测 + 前端 5 处调用均有测试锁定 |
| 5 分享链接带前缀且不落库 | ✅ `test_13` + `test_20` |
| 6/7 端口与鉴权 | ⏳ 运维配置，见 8.3 |

新增 12 项契约测试（`tests/test_deploy_prefix.py`），已挂进 `tests/run_all.sh`。

### 8.2 一次真实回归

`tests/theme.test.js` 里硬编码了 `src="/static/theme.js"`，加前缀后失败。
这不是测试误报——它锁的正是"index.html 确实加载了 theme.js"这个事实。
把正则改为前缀可选 `(?:%%PREFIX%%)?`，既保留原意图又兼容两种部署形态。

### 8.3 服务器部署步骤（不进仓库）

**1) 数据迁移**（本地 → 服务器，用 `.backup` 而非 `cp`，WAL 半写状态会坏库）

```bash
sqlite3 data/chattool.db ".backup /tmp/chattool-clean.db"
scp /tmp/chattool-clean.db 服务器:~/apps/data/chattool/chattool.db
```

**2) compose**（`~/apps/docker-compose.yml`）

```yaml
services:
  chattool:
    build: ./ChatTools
    restart: unless-stopped
    ports: ["127.0.0.1:8765:8765"]      # 只绑本地，公网必须过 Nginx
    volumes:
      - ./data/chattool:/app/data       # 数据在容器外，重建不丢
    environment:
      - CHATTOOL_PREFIX=/8000
      - CHATTOOL_CORS_ORIGINS=https://你的域名
```

**3) Nginx**

```nginx
location /8000/ {
    auth_basic "ChatTools";
    auth_basic_user_file /etc/nginx/.htpasswd;

    proxy_pass http://127.0.0.1:8765/;   # ★ 尾斜杠必须成对
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_buffering off;                 # ★ SSE 流式生成必需
    proxy_read_timeout 300s;
}
```

`proxy_buffering off` 不设的后果：`/api/generate` 是 SSE，Nginx 默认攒够缓冲区才吐，
手机上表现为"发完消息一直转圈，几十秒后一次全出来"，很像卡死。

**4) 密码**

```bash
printf "lwy:%s\n" "$(openssl passwd -apr1 '你的密码')" > /etc/nginx/.htpasswd
```

**5) 上线与更新**

```bash
cd ~/apps && docker compose up -d --build chattool
nginx -t && nginx -s reload

# 后续更新
cd ~/apps/ChatTools && git pull && cd ~/apps && docker compose up -d --build chattool
```

### 8.4 回滚

```bash
docker compose down chattool        # 停掉
python -m app --port 8765           # 本机照常可用（本地库保留未动）
```

### 8.5 遗留

- **MutipleChat 的 `CHATTOOL_DRAW_URL` 仍硬编码 `http://127.0.0.1:8765`**，
  手机上必然失败。同源部署后应改为 `location.origin + '/8000/api/favorites/draw'`，
  另开一张票处理，不在本票范围。
