"""CLI панели: локальный backend + браузер или нативное окно (pywebview).

lucrium-panel                 # http://127.0.0.1:8765 + браузер
lucrium-panel --window        # нативное окно (pywebview, EdgeChromium)
lucrium-panel --no-browser    # только сервер (для разработки)
"""

from __future__ import annotations

import argparse
import contextlib
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn
from platformdirs import user_log_dir

from . import __version__
from .api import create_app
from .settings import default_settings_path


def _ensure_streams() -> None:
    """Windowed exe (PyInstaller console=False) не имеет stdout/stderr — uvicorn падает.

    Направляем оба потока в ``panel.log`` (плюс это удобно для диагностики).
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    log_dir = Path(user_log_dir("Lucrium", "Lucrium"))
    log_dir.mkdir(parents=True, exist_ok=True)
    stream = (log_dir / "panel.log").open("a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


def main(argv: list[str] | None = None) -> int:
    _ensure_streams()
    parser = argparse.ArgumentParser(prog="lucrium-panel", description="Lucrium Panel")
    parser.add_argument("--version", action="version", version=f"lucrium-panel {__version__}")
    parser.add_argument("--host", default="127.0.0.1", help="адрес локального backend (только localhost)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--window", action="store_true", help="открыть нативное окно (pywebview)")
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    parser.add_argument("--settings", default=None, help="путь к panel.json")
    args = parser.parse_args(argv)

    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        print(
            "error: --host ограничен loopback (127.0.0.1/localhost/::1); локальный API не предназначен для сети",
            file=sys.stderr,
        )
        return 2

    settings_path = Path(args.settings) if args.settings else default_settings_path()
    dev_origin = os.environ.get("LUCRIUM_DEV_ORIGIN", "").strip()
    allowed_origins = (dev_origin,) if dev_origin else ()
    app = create_app(
        settings_path=settings_path,
        port=args.port,
        allowed_origins=allowed_origins,
    )
    url = f"http://{args.host}:{args.port}"
    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="info")
    server = uvicorn.Server(config)

    want_window = args.window or (bool(getattr(sys, "frozen", False)) and not args.no_browser)
    if want_window:
        code = _run_window(server, url)
        if code != 2:  # 2 = pywebview недоступен → откатываемся в браузер
            return code
    return _run_browser(server, url, open_browser=not args.no_browser)


def _run_browser(server: uvicorn.Server, url: str, *, open_browser: bool) -> int:
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"Lucrium Panel: {url}")
    server.run()
    return 0


def _run_window(server: uvicorn.Server, url: str) -> int:
    try:
        import webview
    except ImportError:
        print("pywebview не установлен: `uv sync --extra desktop` или запустите без --window", file=sys.stderr)
        return 2

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    if not server.started:
        print("backend не запустился", file=sys.stderr)
        return 1
    webview.create_window("Lucrium", url, width=1280, height=860, min_size=(1024, 720))
    try:
        webview.start()
    finally:
        server.should_exit = True
        with contextlib.suppress(Exception):
            thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    sys.exit(main())
