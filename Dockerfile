# ChatTool 运行镜像
#
# 只带运行期需要的东西：app/ + static/ + frontend/。
# 测试、文档、虚拟环境、本地数据库一律不进镜像（见 .dockerignore）——
# 尤其 data/ 里是用户的 SQLite 库和 LLM API Key，打进去等于把 Key 分发到镜像层。
FROM python:3.13-slim

WORKDIR /app

# 先装依赖再拷代码：改一行代码不必重装依赖，构建更快
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY static/ ./static/
COPY frontend/ ./frontend/

# 数据目录由 compose 挂卷覆盖，这里只建目录保证非挂载场景也能跑
ENV CHATTOOL_DATA=/app/data
RUN mkdir -p /app/data

# 0.0.0.0 是**容器内**监听地址，宿主机端口由 compose 绑到 127.0.0.1，
# 不对公网暴露；公网访问一律经 Nginx（含 Basic Auth），见 doc/feat/deploy-8000.md
EXPOSE 8765

CMD ["python", "-m", "app", "--host", "0.0.0.0", "--port", "8765"]
