from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn


APP_NAME = "D-aquila Windows Edition"
EXE_NAME = "D-aquila-Windows.exe"
DEFAULT_PORT = 8000
DEVNULL_HANDLE = None


def default_install_dir() -> Path:
    base = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "Programs" / "D-aquila Windows Edition"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def current_executable() -> Path:
    return Path(sys.executable if is_frozen() else __file__).resolve()


def open_browser(port: int) -> None:
    time.sleep(1.2)
    webbrowser.open(f"http://localhost:{port}")


def ensure_console_streams() -> None:
    global DEVNULL_HANDLE
    if sys.stdout is not None and sys.stderr is not None:
        return
    DEVNULL_HANDLE = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = DEVNULL_HANDLE
    if sys.stderr is None:
        sys.stderr = DEVNULL_HANDLE


def run_app(port: int = DEFAULT_PORT, host: str = "127.0.0.1") -> None:
    ensure_console_streams()
    os.environ.setdefault("D_AQUILA_AUTH_MODE", "disabled")
    os.environ.setdefault("D_AQUILA_ENABLE_SUBMIT", "false")
    os.environ.setdefault("D_AQUILA_HOST_SLURM_FALLBACK", "false")
    os.environ.setdefault("D_AQUILA_PORT", str(port))
    os.environ.setdefault("D_AQUILA_HOST", host)
    threading.Thread(target=open_browser, args=(port,), daemon=True).start()
    from backend.d_aquila import app

    uvicorn.run(app, host=host, port=port, log_config=None, access_log=False)


def run_powershell(script: str) -> None:
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
    )


def ps_quote(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def create_shortcut(shortcut_path: Path, target: Path, args: str = "") -> None:
    shortcut_path.parent.mkdir(parents=True, exist_ok=True)
    script = rf"""
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut({ps_quote(shortcut_path)})
$Shortcut.TargetPath = {ps_quote(target)}
$Shortcut.Arguments = {ps_quote(args)}
$Shortcut.WorkingDirectory = {ps_quote(target.parent)}
$Shortcut.IconLocation = {ps_quote(str(target) + ',0')}
$Shortcut.Save()
"""
    run_powershell(script)


def install_app(install_dir: Path, desktop_shortcut: bool = True, start_menu_shortcut: bool = True) -> Path:
    source = current_executable()
    install_dir.mkdir(parents=True, exist_ok=True)
    target = install_dir / EXE_NAME
    if source != target:
        shutil.copy2(source, target)

    if start_menu_shortcut:
        start_menu = Path(os.getenv("APPDATA") or str(Path.home() / "AppData" / "Roaming")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "D-aquila"
        create_shortcut(start_menu / "D-aquila Windows Edition.lnk", target, "--run")

    if desktop_shortcut:
        desktop = Path.home() / "Desktop"
        create_shortcut(desktop / "D-aquila Windows Edition.lnk", target, "--run")

    return target


def uninstall_app(install_dir: Path) -> None:
    start_menu = Path(os.getenv("APPDATA") or str(Path.home() / "AppData" / "Roaming")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "D-aquila"
    desktop_shortcut = Path.home() / "Desktop" / "D-aquila Windows Edition.lnk"
    for path in [desktop_shortcut, start_menu / "D-aquila Windows Edition.lnk"]:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        shutil.rmtree(start_menu)
    except OSError:
        pass
    try:
        shutil.rmtree(install_dir)
    except OSError:
        pass


def run_installer_gui() -> None:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title(APP_NAME)
    root.geometry("620x430")
    root.resizable(False, False)

    install_dir = tk.StringVar(value=str(default_install_dir()))
    desktop_shortcut = tk.BooleanVar(value=True)
    start_menu_shortcut = tk.BooleanVar(value=True)
    launch_after_install = tk.BooleanVar(value=True)
    status = tk.StringVar(value="설치 위치와 바로가기 옵션을 확인한 뒤 설치를 누르세요.")

    frame = ttk.Frame(root, padding=24)
    frame.pack(fill="both", expand=True)

    ttk.Label(frame, text="D-aquila Windows Edition", font=("Segoe UI", 20, "bold")).pack(anchor="w")
    ttk.Label(
        frame,
        text="Windows 서버에 D-aquila 단독 관제 도구를 설치합니다.",
        font=("Segoe UI", 10),
    ).pack(anchor="w", pady=(4, 20))

    path_frame = ttk.LabelFrame(frame, text="설치 위치", padding=12)
    path_frame.pack(fill="x")
    path_row = ttk.Frame(path_frame)
    path_row.pack(fill="x")
    ttk.Entry(path_row, textvariable=install_dir).pack(side="left", fill="x", expand=True)

    def browse() -> None:
        selected = filedialog.askdirectory(initialdir=install_dir.get())
        if selected:
            install_dir.set(selected)

    ttk.Button(path_row, text="찾아보기", command=browse).pack(side="left", padx=(8, 0))

    option_frame = ttk.LabelFrame(frame, text="설치 옵션", padding=12)
    option_frame.pack(fill="x", pady=14)
    ttk.Checkbutton(option_frame, text="바탕화면 바로가기 만들기", variable=desktop_shortcut).pack(anchor="w")
    ttk.Checkbutton(option_frame, text="시작 메뉴 바로가기 만들기", variable=start_menu_shortcut).pack(anchor="w")
    ttk.Checkbutton(option_frame, text="설치 완료 후 바로 실행", variable=launch_after_install).pack(anchor="w")

    ttk.Label(
        frame,
        textvariable=status,
        foreground="#0f766e",
        wraplength=560,
    ).pack(anchor="w", pady=(6, 14))

    button_row = ttk.Frame(frame)
    button_row.pack(side="bottom", fill="x")

    def do_install() -> None:
        try:
            status.set("설치 중입니다...")
            root.update_idletasks()
            target = install_app(Path(install_dir.get()), desktop_shortcut.get(), start_menu_shortcut.get())
            status.set("설치가 완료되었습니다.")
            if launch_after_install.get():
                subprocess.Popen(
                    [str(target), "--run"],
                    cwd=str(target.parent),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            messagebox.showinfo(APP_NAME, "D-aquila Windows Edition 설치가 완료되었습니다.")
            root.destroy()
        except Exception as exc:
            messagebox.showerror(APP_NAME, f"설치 실패: {exc}")
            status.set("설치에 실패했습니다.")

    ttk.Button(button_row, text="취소", command=root.destroy).pack(side="right")
    ttk.Button(button_row, text="설치", command=do_install).pack(side="right", padx=(0, 8))

    root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser(description=APP_NAME)
    parser.add_argument("--run", action="store_true", help="Run D-aquila instead of opening installer UI.")
    parser.add_argument("--setup", action="store_true", help="Force installer UI.")
    parser.add_argument("--uninstall", action="store_true", help="Remove shortcuts and local install directory.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    install_dir = default_install_dir()
    installed_exe = install_dir / EXE_NAME
    running_installed_exe = current_executable() == installed_exe

    if args.uninstall:
        uninstall_app(install_dir)
        return

    if args.run or (running_installed_exe and not args.setup):
        run_app(args.port, args.host)
        return

    run_installer_gui()


if __name__ == "__main__":
    main()
