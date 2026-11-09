#!/usr/bin/env bash
# 运行全部测试：后端 API + 服务端 Markdown + 前端 Markdown 渲染器
set -e
cd "$(dirname "$0")/.."
echo "===== 后端 API 测试 ====="
python3 -m tests.test_api
echo
echo "===== 服务端 Markdown 测试 ====="
python3 -m tests.test_markdown
echo
echo "===== 前端 Markdown 渲染器测试 ====="
node tests/markdown.test.js
