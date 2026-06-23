from __future__ import annotations

import json
import os
import platform
import re
import secrets
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import shutil
import socket
from datetime import datetime
from pathlib import Path
from typing import Any

import psutil
from fastapi import Cookie, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parents[1]
PROMETHEUS_URL = os.getenv("D_AQUILA_PROMETHEUS_URL", "http://localhost:9090").rstrip("/")
ENABLE_SUBMIT = os.getenv("D_AQUILA_ENABLE_SUBMIT", "false").lower() in {"1", "true", "yes", "on"}
COMMAND_TIMEOUT = int(os.getenv("D_AQUILA_COMMAND_TIMEOUT", "10"))
AUTH_MODE = os.getenv("D_AQUILA_AUTH_MODE", "pam").lower()
AUTH_SESSION_SECONDS = int(os.getenv("D_AQUILA_AUTH_SESSION_SECONDS", "28800"))
SESSION_COOKIE = "d_aquila_session"
SESSIONS: dict[str, dict[str, Any]] = {}


app = FastAPI(title="D-aquila API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    public_paths = {"/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me"}
    if path.startswith("/api/") and path not in public_paths:
        if not session_user(request.cookies.get(SESSION_COOKIE)):
            return JSONResponse({"detail": "Login required"}, status_code=401)
    response = await call_next(request)
    if not path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response


class SubmitRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    partition: str = Field(min_length=1, max_length=80)
    cpu: int = Field(ge=1, le=1024)
    gpu: int = Field(ge=0, le=16)
    memory: str = Field(min_length=1, max_length=32)
    time: str = Field(min_length=1, max_length=32)
    script: str = Field(min_length=1, max_length=20000)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=4096)


def session_user(token: str | None) -> str | None:
    if AUTH_MODE == "disabled":
        return os.getenv("USER") or os.getenv("USERNAME") or "local"
    if not token:
        return None
    session = SESSIONS.get(token)
    if not session:
        return None
    if float(session["expires_at"]) < time.time():
        SESSIONS.pop(token, None)
        return None
    return str(session["username"])


def require_user(d_aquila_session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> str:
    username = session_user(d_aquila_session)
    if not username:
        raise HTTPException(status_code=401, detail="Login required")
    return username


def authenticate_os_user(username: str, password: str) -> None:
    if AUTH_MODE == "disabled":
        return
    if AUTH_MODE != "pam":
        raise HTTPException(status_code=503, detail=f"Unsupported auth mode: {AUTH_MODE}")
    try:
        import pamela
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="PAM authentication is not available in this runtime") from exc
    try:
        pamela.authenticate(username, password)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid OS username or password") from exc


def pam_available() -> bool:
    try:
        import pamela  # noqa: F401
    except ImportError:
        return False
    return True


@app.post("/api/auth/login")
def login(request: LoginRequest, response: Response) -> dict[str, Any]:
    authenticate_os_user(request.username, request.password)
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = {
        "username": request.username,
        "expires_at": time.time() + AUTH_SESSION_SECONDS,
    }
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=os.getenv("D_AQUILA_COOKIE_SECURE", "false").lower() in {"1", "true", "yes", "on"},
        max_age=AUTH_SESSION_SECONDS,
    )
    return {"authenticated": True, "username": request.username, "auth_mode": AUTH_MODE}


@app.post("/api/auth/logout")
def logout(response: Response, d_aquila_session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    if d_aquila_session:
        SESSIONS.pop(d_aquila_session, None)
    response.delete_cookie(SESSION_COOKIE)
    return {"authenticated": False}


@app.get("/api/auth/me")
def me(d_aquila_session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    username = session_user(d_aquila_session)
    return {
        "authenticated": bool(username),
        "username": username,
        "auth_mode": AUTH_MODE,
    }


def run_command(args: list[str]) -> str:
    try:
        proc = subprocess.run(
            args,
            check=False,
            text=True,
            capture_output=True,
            timeout=COMMAND_TIMEOUT,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=f"Command not found: {args[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"Command timed out: {' '.join(args)}") from exc

    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"exit code {proc.returncode}"
        raise HTTPException(status_code=502, detail=f"{args[0]} failed: {detail}")
    return proc.stdout


def run_command_optional(args: list[str], timeout: int | None = None) -> tuple[str, str | None]:
    try:
        proc = subprocess.run(
            args,
            check=False,
            text=True,
            capture_output=True,
            timeout=timeout or COMMAND_TIMEOUT,
        )
    except FileNotFoundError:
        return "", f"Command not found: {args[0]}"
    except subprocess.TimeoutExpired:
        return "", f"Command timed out: {' '.join(args)}"

    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"exit code {proc.returncode}"
        return proc.stdout or "", detail
    return proc.stdout, None


def prometheus(path: str, params: dict[str, str] | None = None) -> Any:
    query = urllib.parse.urlencode(params or {})
    url = f"{PROMETHEUS_URL}{path}"
    if query:
        url = f"{url}?{query}"
    try:
        with urllib.request.urlopen(url, timeout=COMMAND_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Prometheus unavailable: {exc}") from exc

    if payload.get("status") != "success":
        raise HTTPException(status_code=502, detail=f"Prometheus error: {payload}")
    return payload["data"]


def prom_value(query: str, default: float = 0.0) -> float:
    try:
        data = prometheus("/api/v1/query", {"query": query})
        result = data.get("result", [])
        if not result:
            return default
        return float(result[0]["value"][1])
    except HTTPException:
        return default
    except (KeyError, ValueError, TypeError):
        return default


def bytes_per_second(value: float) -> float:
    return round(value, 2)


def human_duration(seconds: float) -> str:
    total = int(max(seconds, 0))
    days, remainder = divmod(total, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, _ = divmod(remainder, 60)
    if days:
        return f"{days}d {hours}h {minutes}m"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def read_filesystems() -> list[dict[str, Any]]:
    seen: set[str] = set()
    filesystems: list[dict[str, Any]] = []
    for partition in psutil.disk_partitions(all=False):
        mountpoint = partition.mountpoint
        if mountpoint in seen:
            continue
        seen.add(mountpoint)
        try:
            usage = psutil.disk_usage(mountpoint)
        except (PermissionError, OSError):
            continue
        filesystems.append(
            {
                "device": partition.device,
                "mountpoint": mountpoint,
                "fstype": partition.fstype,
                "total_bytes": usage.total,
                "used_bytes": usage.used,
                "free_bytes": usage.free,
                "usage_percent": round(usage.percent, 1),
            }
        )
    return filesystems[:12]


def local_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def read_os_release() -> dict[str, str]:
    for path in [Path("/host/etc/os-release"), Path("/etc/os-release")]:
        if not path.exists():
            continue
        values: dict[str, str] = {}
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                values[key] = value.strip().strip('"')
        except OSError:
            continue
        if values:
            return {
                "name": values.get("NAME", ""),
                "pretty_name": values.get("PRETTY_NAME", ""),
                "version": values.get("VERSION", ""),
                "version_id": values.get("VERSION_ID", ""),
                "version_codename": values.get("VERSION_CODENAME", "") or values.get("UBUNTU_CODENAME", ""),
                "id": values.get("ID", ""),
                "id_like": values.get("ID_LIKE", ""),
            }
    return {}


def read_temperature() -> dict[str, Any]:
    try:
        sensors = psutil.sensors_temperatures(fahrenheit=False)
    except (AttributeError, OSError):
        sensors = {}

    readings = []
    for chip, entries in sensors.items():
        for entry in entries:
            if entry.current is None:
                continue
            readings.append(
                {
                    "chip": chip,
                    "label": entry.label or chip,
                    "current_celsius": round(float(entry.current), 1),
                    "high_celsius": round(float(entry.high), 1) if entry.high is not None else None,
                    "critical_celsius": round(float(entry.critical), 1) if entry.critical is not None else None,
                }
            )

    hottest = max((item["current_celsius"] for item in readings), default=None)
    return {"max_celsius": hottest, "readings": readings[:20]}


def parse_kv_line(line: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for match in re.finditer(r"(\w+)=(.*?)(?=\s+\w+=|$)", line.strip()):
        parsed[match.group(1)] = match.group(2).strip()
    return parsed


def parse_tres(tres: str, key: str) -> int:
    if not tres:
        return 0
    match = re.search(rf"(?:^|,){re.escape(key)}=(\d+)", tres)
    return int(match.group(1)) if match else 0


def parse_gres_total(gres: str) -> int:
    if not gres or gres == "(null)":
        return 0
    match = re.search(r"gpu(?::[^:,\s]+)?:(\d+)", gres)
    return int(match.group(1)) if match else 0


def classify_log(message: str, unit: str = "", source: str = "", priority: int | None = None) -> tuple[str, str]:
    text = f"{unit} {source} {message}".lower()
    if priority is not None and priority <= 3:
        level = "error"
    elif priority is not None and priority == 4:
        level = "warn"
    elif any(word in text for word in ["failed", "failure", "error", "critical", "panic", "segfault", "denied"]):
        level = "error"
    elif any(word in text for word in ["warning", "warn", "degraded", "timeout", "retry"]):
        level = "warn"
    else:
        level = "info"

    if any(word in text for word in ["sshd", "sudo", "pam", "authentication", "session", "password", "invalid user", "failed password", "firewalld", "audit"]):
        category = "security"
    elif any(word in text for word in ["kernel", "mce", "edac", "thermal", "temperature", "nvidia", "gpu", "ipmi", "hardware", "pcie", "nvme", "disk", "smart"]):
        category = "hardware"
    elif any(word in text for word in ["slurm", "slurmd", "slurmctld", "munge", "prometheus", "docker", "containerd", "d-aquila"]):
        category = "service"
    else:
        category = "system"
    return category, level


def log_time_from_journal(item: dict[str, Any]) -> str:
    raw = item.get("__REALTIME_TIMESTAMP")
    try:
        if raw:
            return datetime.fromtimestamp(int(raw) / 1_000_000).isoformat(timespec="seconds")
    except (TypeError, ValueError, OSError):
        pass
    return datetime.now().isoformat(timespec="seconds")


def read_journal_logs(limit: int) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    logs: list[dict[str, Any]] = []
    sources: list[dict[str, str]] = []
    commands = [
        ("system", ["journalctl", "-n", str(limit), "--no-pager", "-o", "json"]),
        ("kernel", ["journalctl", "-k", "-n", str(max(20, limit // 3)), "--no-pager", "-o", "json"]),
        ("security", ["journalctl", "-n", str(max(20, limit // 3)), "--no-pager", "-o", "json", "-u", "sshd", "-u", "sudo", "-u", "firewalld"]),
        ("service", ["journalctl", "-n", str(max(20, limit // 3)), "--no-pager", "-o", "json", "-u", "slurmctld", "-u", "slurmd", "-u", "munge", "-u", "docker", "-u", "d-aquila"]),
    ]
    seen: set[tuple[str, str, str]] = set()

    for source_name, command in commands:
        output, error = run_command_optional(command, timeout=4)
        sources.append({"name": source_name, "type": "journalctl", "status": "limited" if error else "ok", "detail": error or "journalctl"})
        if error:
            continue
        for line in output.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = str(item.get("MESSAGE", "")).strip()
            if not message:
                continue
            unit = str(item.get("_SYSTEMD_UNIT") or item.get("SYSLOG_IDENTIFIER") or "")
            source = str(item.get("SYSLOG_IDENTIFIER") or source_name)
            try:
                priority = int(item.get("PRIORITY")) if item.get("PRIORITY") is not None else None
            except ValueError:
                priority = None
            key = (log_time_from_journal(item), source, message)
            if key in seen:
                continue
            seen.add(key)
            category, level = classify_log(message, unit, source, priority)
            logs.append(
                {
                    "time": key[0],
                    "source": source,
                    "unit": unit,
                    "category": category,
                    "level": level,
                    "priority": priority,
                    "message": message[:2000],
                }
            )
    return logs, sources


def read_file_tail(path: Path, max_lines: int = 80) -> tuple[list[str], str | None]:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            return handle.readlines()[-max_lines:], None
    except OSError as exc:
        return [], str(exc)


def read_file_logs(limit: int) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    candidates = [
        ("messages", Path("/host/var/log/messages")),
        ("syslog", Path("/host/var/log/syslog")),
        ("secure", Path("/host/var/log/secure")),
        ("auth", Path("/host/var/log/auth.log")),
        ("kern", Path("/host/var/log/kern.log")),
        ("dmesg", Path("/host/var/log/dmesg")),
    ]
    logs: list[dict[str, Any]] = []
    sources: list[dict[str, str]] = []
    per_file = max(20, limit // max(len(candidates), 1))
    now = datetime.now().isoformat(timespec="seconds")

    for name, path in candidates:
        if not path.exists():
            sources.append({"name": name, "type": "file", "status": "missing", "detail": str(path)})
            continue
        lines, error = read_file_tail(path, per_file)
        sources.append({"name": name, "type": "file", "status": "limited" if error else "ok", "detail": error or str(path)})
        for line in lines:
            message = line.strip()
            if not message:
                continue
            category, level = classify_log(message, source=name)
            logs.append(
                {
                    "time": now,
                    "source": name,
                    "unit": "",
                    "category": category,
                    "level": level,
                    "priority": None,
                    "message": message[:2000],
                }
            )
    return logs, sources


def log_summary(logs: list[dict[str, Any]], sources: list[dict[str, str]]) -> dict[str, Any]:
    by_category: dict[str, int] = {}
    by_level: dict[str, int] = {}
    for item in logs:
        by_category[item["category"]] = by_category.get(item["category"], 0) + 1
        by_level[item["level"]] = by_level.get(item["level"], 0) + 1
    return {
        "total": len(logs),
        "error": by_level.get("error", 0),
        "warn": by_level.get("warn", 0),
        "info": by_level.get("info", 0),
        "security": by_category.get("security", 0),
        "hardware": by_category.get("hardware", 0),
        "system": by_category.get("system", 0),
        "service": by_category.get("service", 0),
        "sources_ok": sum(1 for source in sources if source["status"] == "ok"),
        "sources_limited": sum(1 for source in sources if source["status"] != "ok"),
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "prometheus_url": PROMETHEUS_URL,
        "submit_enabled": ENABLE_SUBMIT,
    }


@app.get("/api/discovery")
def discovery() -> dict[str, Any]:
    commands = {
        "sinfo": shutil.which("sinfo"),
        "squeue": shutil.which("squeue"),
        "scontrol": shutil.which("scontrol"),
        "sbatch": shutil.which("sbatch"),
        "scancel": shutil.which("scancel"),
    }
    slurm_config_paths = [path for path in ["/etc/slurm", "/etc/slurm-llnl"] if Path(path).exists()]
    munge_sockets = [
        path
        for path in ["/run/munge/munge.socket.2", "/var/run/munge/munge.socket.2"]
        if Path(path).exists()
    ]

    prometheus_ready = False
    prometheus_targets: dict[str, int] = {}
    try:
        data = prometheus("/api/v1/targets")
        prometheus_ready = True
        for target in data.get("activeTargets", []):
            job = target.get("labels", {}).get("job", "unknown")
            prometheus_targets[job] = prometheus_targets.get(job, 0) + 1
    except HTTPException:
        prometheus_ready = False

    return {
        "commands": commands,
        "slurm_config_paths": slurm_config_paths,
        "munge_sockets": munge_sockets,
        "prometheus": {
            "url": PROMETHEUS_URL,
            "ready": prometheus_ready,
            "targets_by_job": prometheus_targets,
        },
        "submit_enabled": ENABLE_SUBMIT,
        "auth": {
            "mode": AUTH_MODE,
            "pam_available": pam_available(),
            "session_seconds": AUTH_SESSION_SECONDS,
        },
        "runtime": {
            "disk_path": os.getenv("D_AQUILA_DISK_PATH", "/"),
            "command_timeout": COMMAND_TIMEOUT,
        },
    }


@app.get("/api/summary")
def summary() -> dict[str, float]:
    cpu_alloc = prom_value("sum(slurm_cpus_alloc)")
    cpu_total = prom_value("sum(slurm_cpus_total)")
    gpu_used = prom_value("count(DCGM_FI_DEV_GPU_UTIL > 0)")
    gpu_total = prom_value("count(DCGM_FI_DEV_GPU_UTIL)")
    return {
        "cpu_alloc": cpu_alloc,
        "cpu_total": cpu_total,
        "cpu_usage_percent": (cpu_alloc / cpu_total * 100) if cpu_total else 0,
        "gpu_used": gpu_used,
        "gpu_total": gpu_total,
        "gpu_usage_percent": (gpu_used / gpu_total * 100) if gpu_total else prom_value("avg(DCGM_FI_DEV_GPU_UTIL)"),
        "jobs_running": prom_value("sum(slurm_queue_running)"),
        "jobs_pending": prom_value("sum(slurm_queue_pending)"),
        "nodes_down": prom_value("sum(slurm_nodes_down)"),
        "max_gpu_temp_celsius": prom_value("max(DCGM_FI_DEV_GPU_TEMP)"),
        "gpu_power_watts": prom_value("sum(DCGM_FI_DEV_POWER_USAGE)"),
        "ipmi_up": prom_value('sum(up{job="ipmi"})'),
    }


@app.get("/api/system")
def system_metrics() -> dict[str, Any]:
    net_a = psutil.net_io_counters()
    disk_io_a = psutil.disk_io_counters()
    cpu_percent = psutil.cpu_percent(interval=0.2)
    net_b = psutil.net_io_counters()
    disk_io_b = psutil.disk_io_counters()
    memory = psutil.virtual_memory()
    disk_path = os.getenv("D_AQUILA_DISK_PATH", "/")
    disk = psutil.disk_usage(disk_path)
    load_avg = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)
    boot_timestamp = psutil.boot_time()
    uptime_seconds = datetime.now().timestamp() - boot_timestamp
    boot_time = datetime.fromtimestamp(boot_timestamp).isoformat(timespec="seconds")
    now = datetime.now().astimezone()
    disk_read_delta = (disk_io_b.read_bytes - disk_io_a.read_bytes) if disk_io_a and disk_io_b else 0
    disk_write_delta = (disk_io_b.write_bytes - disk_io_a.write_bytes) if disk_io_a and disk_io_b else 0
    os_release = read_os_release()

    return {
        "hostname": socket.gethostname(),
        "ip_address": local_ip(),
        "os": {
            "system": platform.system(),
            "kernel_release": platform.release(),
            "machine": platform.machine(),
            **os_release,
        },
        "time": now.isoformat(timespec="seconds"),
        "timezone": str(now.tzinfo),
        "boot_time": boot_time,
        "uptime_seconds": round(uptime_seconds),
        "uptime_human": human_duration(uptime_seconds),
        "cpu": {
            "usage_percent": round(cpu_percent, 1),
            "logical_count": psutil.cpu_count(logical=True),
            "physical_count": psutil.cpu_count(logical=False),
            "load1": round(load_avg[0], 2),
            "load5": round(load_avg[1], 2),
            "load15": round(load_avg[2], 2),
        },
        "memory": {
            "total_bytes": memory.total,
            "available_bytes": memory.available,
            "used_bytes": memory.used,
            "usage_percent": round(memory.percent, 1),
        },
        "disk": {
            "path": disk_path,
            "total_bytes": disk.total,
            "used_bytes": disk.used,
            "free_bytes": disk.free,
            "usage_percent": round(disk.percent, 1),
        },
        "filesystems": read_filesystems(),
        "disk_io": {
            "read_bytes_per_sec": bytes_per_second(disk_read_delta / 0.2),
            "write_bytes_per_sec": bytes_per_second(disk_write_delta / 0.2),
            "read_bytes": disk_io_b.read_bytes if disk_io_b else 0,
            "write_bytes": disk_io_b.write_bytes if disk_io_b else 0,
            "read_count": disk_io_b.read_count if disk_io_b else 0,
            "write_count": disk_io_b.write_count if disk_io_b else 0,
        },
        "network": {
            "rx_bytes_per_sec": bytes_per_second((net_b.bytes_recv - net_a.bytes_recv) / 0.2),
            "tx_bytes_per_sec": bytes_per_second((net_b.bytes_sent - net_a.bytes_sent) / 0.2),
            "bytes_recv": net_b.bytes_recv,
            "bytes_sent": net_b.bytes_sent,
        },
        "temperature": read_temperature(),
    }


@app.get("/api/targets")
def targets() -> dict[str, Any]:
    data = prometheus("/api/v1/targets")
    active = data.get("activeTargets", [])
    return {
        "targets": [
            {
                "job": target.get("labels", {}).get("job", ""),
                "instance": target.get("labels", {}).get("instance", ""),
                "health": target.get("health", ""),
                "lastError": target.get("lastError", ""),
                "scrapeUrl": target.get("scrapeUrl", ""),
            }
            for target in active
        ]
    }


@app.get("/api/logs")
def logs(limit: int = 180) -> dict[str, Any]:
    safe_limit = max(20, min(limit, 500))
    journal_logs, journal_sources = read_journal_logs(safe_limit)
    file_logs, file_sources = read_file_logs(safe_limit)
    combined = journal_logs + file_logs
    combined.sort(key=lambda item: item.get("time", ""), reverse=True)
    combined = combined[:safe_limit]
    sources = journal_sources + file_sources
    return {
        "logs": combined,
        "summary": log_summary(combined, sources),
        "sources": sources,
        "host": socket.gethostname(),
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


@app.get("/api/partitions")
def partitions() -> dict[str, Any]:
    output = run_command(["sinfo", "-h", "-o", "%P|%C|%t|%N|%D|%G|%l|%f"])
    rows = []
    for line in output.splitlines():
        parts = line.split("|")
        if len(parts) < 8:
            continue
        rows.append(
            {
                "partition": parts[0].rstrip("*"),
                "default": parts[0].endswith("*"),
                "cpus": parts[1],
                "state": parts[2],
                "nodelist": parts[3],
                "nodes": int(parts[4]) if parts[4].isdigit() else 0,
                "gres": parts[5],
                "timelimit": parts[6],
                "features": parts[7],
            }
        )
    return {"partitions": rows}


@app.get("/api/jobs")
def jobs() -> dict[str, Any]:
    fmt = "%i|%j|%t|%u|%g|%P|%q|%D|%R|%c|%b|%l|%L|%Q"
    output = run_command(["squeue", "-h", "-o", fmt])
    rows = []
    state_map = {"R": "running", "PD": "pending", "CG": "completing", "CD": "completed", "F": "failed"}
    for line in output.splitlines():
        parts = line.split("|")
        if len(parts) < 14:
            continue
        tres = parts[10] if parts[10] != "N/A" else ""
        cpu = parts[9]
        resource = f"{cpu} CPU"
        if tres:
            resource = f"{tres} / {resource}"
        rows.append(
            {
                "id": parts[0].strip(),
                "name": parts[1].strip(),
                "status": state_map.get(parts[2].strip(), parts[2].strip()),
                "user": parts[3].strip(),
                "group": parts[4].strip(),
                "partition": parts[5].strip(),
                "qos": parts[6].strip(),
                "nodes": parts[7].strip(),
                "reason": parts[8].strip().strip("()"),
                "min_cpus": cpu.strip(),
                "tres": tres.strip(),
                "resource": resource,
                "limit": parts[11].strip(),
                "time": parts[12].strip(),
                "priority": parts[13].strip(),
            }
        )
    return {"jobs": rows}


@app.get("/api/nodes")
def nodes() -> dict[str, Any]:
    output = run_command(["scontrol", "show", "node", "-o"])
    rows = []
    for line in output.splitlines():
        item = parse_kv_line(line)
        if not item.get("NodeName"):
            continue
        cfg_tres = item.get("CfgTRES", "")
        alloc_tres = item.get("AllocTRES", "")
        rows.append(
            {
                "name": item.get("NodeName", ""),
                "addr": item.get("NodeAddr", ""),
                "hostname": item.get("NodeHostName", ""),
                "state": item.get("State", ""),
                "partitions": item.get("Partitions", ""),
                "gres": item.get("Gres", ""),
                "cpu_alloc": int(item.get("CPUAlloc", "0") or 0),
                "cpu_total": int(item.get("CPUTot", "0") or 0),
                "cpu_load": float(item.get("CPULoad", "0") or 0),
                "mem_total_mb": int(item.get("RealMemory", "0") or 0),
                "mem_free_mb": int(item.get("FreeMem", "0") or 0) if item.get("FreeMem", "0").isdigit() else 0,
                "gpu_total": parse_gres_total(item.get("Gres", "")) or parse_tres(cfg_tres, "gres/gpu"),
                "gpu_alloc": parse_tres(alloc_tres, "gres/gpu"),
                "reason": item.get("Reason", ""),
                "boot_time": item.get("BootTime", ""),
                "slurmd_start_time": item.get("SlurmdStartTime", ""),
            }
        )
    return {"nodes": rows}


@app.post("/api/jobs/submit")
def submit_job(request: SubmitRequest) -> dict[str, Any]:
    if not ENABLE_SUBMIT:
        raise HTTPException(
            status_code=403,
            detail="Job submission is disabled. Set D_AQUILA_ENABLE_SUBMIT=true on the login node to enable sbatch.",
        )

    with tempfile.NamedTemporaryFile("w", suffix=".sbatch", prefix="d-aquila-", delete=False) as handle:
        handle.write(request.script)
        script_path = handle.name

    try:
        output = run_command(["sbatch", script_path])
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass

    match = re.search(r"Submitted batch job (\S+)", output)
    return {"submitted": True, "job_id": match.group(1) if match else None, "output": output.strip()}


app.mount("/", StaticFiles(directory=ROOT, html=True), name="static")
