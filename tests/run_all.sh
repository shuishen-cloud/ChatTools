#!/usr/bin/env bash
# 运行全部测试：后端 API + 服务端 Markdown + 前端 Markdown 渲染器
set -e
cd "$(dirname "$0")/.."
echo "===== 后端 API 测试 ====="
python3 -m tests.test_api
echo
echo "===== 画板作为一级视图 ====="
python3 -m tests.test_board_view
echo
echo "===== 画板融入系统（归类/尺寸/Markdown）====="
python3 -m tests.test_board_integration
echo
echo "===== 多对话 tab ====="
python3 -m tests.test_chat_tabs
echo
echo "===== tab 状态机（行为）====="
node tests/tab_state.test.js
echo
echo "===== 服务端 Markdown 测试 ====="
python3 -m tests.test_markdown
echo
echo "===== 前端 Markdown 渲染器测试 ====="
node tests/markdown.test.js
echo
echo "===== CSS hidden 层叠检查 ====="
node tests/css_hidden.test.js
echo
echo "===== 白天/黑夜主题检查 ====="
node tests/theme.test.js
echo
node tests/theme_logic.test.js
