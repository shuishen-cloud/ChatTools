"""ChatTool 应用入口：python -m app [--host H] [--port P]"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.routes import create_app  # noqa: E402

app = create_app()


def main() -> None:
    import uvicorn
    parser = argparse.ArgumentParser(description="ChatTool 对话信息管理器")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    uvicorn.run("app.main:app" if args.reload else app, host=args.host,
                port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
