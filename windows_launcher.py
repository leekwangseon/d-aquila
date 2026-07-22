from __future__ import annotations

import os
import threading
import time
import webbrowser

import uvicorn


def open_browser(port: int) -> None:
    time.sleep(1.2)
    webbrowser.open(f"http://localhost:{port}")


def main() -> None:
    port = int(os.getenv("D_AQUILA_PORT", "8000"))
    host = os.getenv("D_AQUILA_HOST", "127.0.0.1")
    os.environ.setdefault("D_AQUILA_AUTH_MODE", "disabled")
    os.environ.setdefault("D_AQUILA_ENABLE_SUBMIT", "false")
    os.environ.setdefault("D_AQUILA_HOST_SLURM_FALLBACK", "false")
    threading.Thread(target=open_browser, args=(port,), daemon=True).start()
    uvicorn.run("backend.d_aquila:app", host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
