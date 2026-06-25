from __future__ import annotations

import json
import hmac
import math
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
import urllib.error
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
GENERATED_DIR = ROOT / "generated"
CONFIG_PATH = GENERATED_DIR / "d-aquila-config.json"
AUDIT_LOG_PATH = GENERATED_DIR / "audit.log"
PROMETHEUS_URL = os.getenv("D_AQUILA_PROMETHEUS_URL", "http://localhost:9090").rstrip("/")
ENABLE_SUBMIT = os.getenv("D_AQUILA_ENABLE_SUBMIT", "false").lower() in {"1", "true", "yes", "on"}
COMMAND_TIMEOUT = int(os.getenv("D_AQUILA_COMMAND_TIMEOUT", "10"))
AUTH_MODE = os.getenv("D_AQUILA_AUTH_MODE", "pam").lower()
AUTH_SHADOW_FALLBACK = os.getenv("D_AQUILA_AUTH_SHADOW_FALLBACK", "true").lower() in {"1", "true", "yes", "on"}
AUTH_SESSION_SECONDS = int(os.getenv("D_AQUILA_AUTH_SESSION_SECONDS", "28800"))
HOST_SLURM_FALLBACK = os.getenv("D_AQUILA_HOST_SLURM_FALLBACK", "true").lower() in {"1", "true", "yes", "on"}
SITE_NAME = os.getenv("D_AQUILA_SITE_NAME", "")
SITE_FACILITY = os.getenv("D_AQUILA_SITE_FACILITY", "")
SITE_LATITUDE = os.getenv("D_AQUILA_SITE_LATITUDE", "")
SITE_LONGITUDE = os.getenv("D_AQUILA_SITE_LONGITUDE", "")
SITE_AUTO = os.getenv("D_AQUILA_SITE_AUTO", "true").lower() in {"1", "true", "yes", "on"}
SESSION_COOKIE = "d_aquila_session"
SESSIONS: dict[str, dict[str, Any]] = {}
RUNTIME_CONFIG: dict[str, Any] = {}
SITE_CACHE: dict[str, Any] = {"expires_at": 0.0, "value": None}


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


class JobCancelRequest(BaseModel):
    reason: str = Field(default="", max_length=240)


class JobPolicyRequest(BaseModel):
    enabled: bool = False
    allowed_partitions: list[str] = Field(default_factory=list)
    max_cpu: int = Field(default=64, ge=1, le=4096)
    max_gpu: int = Field(default=8, ge=0, le=128)
    max_memory_gb: int = Field(default=256, ge=1, le=4096)
    max_time_hours: int = Field(default=24, ge=1, le=24 * 30)
    allow_custom_script: bool = True


class PrometheusConfigRequest(BaseModel):
    url: str = Field(min_length=1, max_length=300)
    node_targets: list[str] = Field(default_factory=list)
    dcgm_targets: list[str] = Field(default_factory=list)
    ipmi_targets: list[str] = Field(default_factory=list)


class AccessModelRequest(BaseModel):
    admin_users: list[str] = Field(default_factory=list)
    operator_users: list[str] = Field(default_factory=list)
    viewer_users: list[str] = Field(default_factory=list)
    admin_groups: list[str] = Field(default_factory=list)
    operator_groups: list[str] = Field(default_factory=list)
    viewer_groups: list[str] = Field(default_factory=list)


class JobTemplateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    partition: str = Field(min_length=1, max_length=80)
    cpu: int = Field(ge=1, le=4096)
    gpu: int = Field(ge=0, le=128)
    memory: str = Field(min_length=1, max_length=32)
    time: str = Field(min_length=1, max_length=32)
    script: str = Field(min_length=1, max_length=20000)
    requires_approval: bool = True


class ApprovalRequest(BaseModel):
    template_id: str = Field(min_length=1, max_length=80)
    parameters: dict[str, Any] = Field(default_factory=dict)


class ApprovalDecisionRequest(BaseModel):
    action: str = Field(min_length=1, max_length=20)
    comment: str = Field(default="", max_length=500)


class FacilityLayoutRequest(BaseModel):
    rooms: list[dict[str, Any]] = Field(default_factory=list)
    racks: list[dict[str, Any]] = Field(default_factory=list)


class AlertChannelsRequest(BaseModel):
    webhook_url: str = Field(default="", max_length=500)
    email_recipients: list[str] = Field(default_factory=list)
    enabled_events: list[str] = Field(default_factory=list)


def default_policy() -> dict[str, Any]:
    return {
        "enabled": ENABLE_SUBMIT,
        "allowed_partitions": [],
        "max_cpu": 64,
        "max_gpu": 8,
        "max_memory_gb": 256,
        "max_time_hours": 24,
        "allow_custom_script": True,
    }


def default_access_model() -> dict[str, Any]:
    return {
        "admin_users": ["root"],
        "operator_users": [],
        "viewer_users": [],
        "admin_groups": ["root", "wheel"],
        "operator_groups": [],
        "viewer_groups": [],
    }


def default_templates() -> list[dict[str, Any]]:
    return [
        {
            "id": "cpu-basic",
            "name": "CPU 기본 작업",
            "partition": "cpu",
            "cpu": 4,
            "gpu": 0,
            "memory": "16G",
            "time": "02:00:00",
            "script": "#!/bin/bash\nhostname\ndate\n",
            "requires_approval": True,
        },
        {
            "id": "gpu-basic",
            "name": "GPU 기본 작업",
            "partition": "gpu",
            "cpu": 8,
            "gpu": 1,
            "memory": "64G",
            "time": "04:00:00",
            "script": "#!/bin/bash\nnvidia-smi\nhostname\ndate\n",
            "requires_approval": True,
        },
    ]


def default_facility_layout() -> dict[str, Any]:
    return {
        "rooms": [{"id": "room-a", "name": "Data Hall A", "floor": "2F"}],
        "racks": [{"id": "rack-a01", "name": "Rack A01", "room_id": "room-a", "units": 42, "pdu_watts": 6000}],
    }


def load_runtime_config() -> dict[str, Any]:
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.exists():
        return {"prometheus": {"url": PROMETHEUS_URL}, "job_policy": default_policy()}
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    return {
        "prometheus": {"url": PROMETHEUS_URL, **(data.get("prometheus") or {})},
        "job_policy": {**default_policy(), **(data.get("job_policy") or {})},
        "access_model": {**default_access_model(), **(data.get("access_model") or {})},
        "job_templates": data.get("job_templates") or default_templates(),
        "approvals": data.get("approvals") or [],
        "facility_layout": {**default_facility_layout(), **(data.get("facility_layout") or {})},
        "alert_channels": {
            "webhook_url": "",
            "email_recipients": [],
            "enabled_events": ["job.submit", "job.cancel", "node.down", "target.down"],
            **(data.get("alert_channels") or {}),
        },
    }


def save_runtime_config() -> None:
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(RUNTIME_CONFIG, ensure_ascii=False, indent=2), encoding="utf-8")


def prometheus_base_url() -> str:
    return str((RUNTIME_CONFIG.get("prometheus") or {}).get("url") or PROMETHEUS_URL).rstrip("/")


def audit(action: str, user: str | None = None, detail: dict[str, Any] | None = None, status: str = "ok") -> None:
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        "time": datetime.now().astimezone().isoformat(timespec="seconds"),
        "user": user or "system",
        "action": action,
        "status": status,
        "detail": detail or {},
    }
    with AUDIT_LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


RUNTIME_CONFIG = load_runtime_config()


def user_groups(username: str | None) -> set[str]:
    if not username:
        return set()
    try:
        import grp
        import pwd

        primary_gid = pwd.getpwnam(username).pw_gid
        groups = {grp.getgrgid(primary_gid).gr_name}
        groups.update(group.gr_name for group in grp.getgrall() if username in group.gr_mem)
        return groups
    except Exception:
        return set()


def user_role(username: str | None) -> str:
    model = RUNTIME_CONFIG.get("access_model") or default_access_model()
    groups = user_groups(username)
    if username in model.get("admin_users", []) or groups.intersection(model.get("admin_groups", [])):
        return "admin"
    if username in model.get("operator_users", []) or groups.intersection(model.get("operator_groups", [])):
        return "operator"
    if username in model.get("viewer_users", []) or groups.intersection(model.get("viewer_groups", [])):
        return "viewer"
    if AUTH_MODE == "disabled":
        return "admin"
    return "viewer"


def require_role(username: str | None, allowed: set[str]) -> None:
    role = user_role(username)
    if role not in allowed:
        raise HTTPException(status_code=403, detail=f"Role '{role}' is not allowed for this operation")


def slug(value: str) -> str:
    clean = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip().lower()).strip("-")
    return clean or secrets.token_hex(4)


def write_file_sd_config(config: dict[str, Any]) -> dict[str, Any]:
    file_sd_dir = GENERATED_DIR / "prometheus" / "file_sd"
    file_sd_dir.mkdir(parents=True, exist_ok=True)
    jobs = {
        "node-exporter": parse_target_lines(config.get("node_targets", [])),
        "dcgm-exporter": parse_target_lines(config.get("dcgm_targets", [])),
        "ipmi-exporter": parse_target_lines(config.get("ipmi_targets", [])),
    }
    written = {}
    for job, targets in jobs.items():
        payload = [{"labels": {"job": job}, "targets": targets}] if targets else []
        path = file_sd_dir / f"{job}.json"
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        written[job] = str(path)
    return written


def reload_prometheus() -> dict[str, Any]:
    url = f"{prometheus_base_url()}/-/reload"
    req = urllib.request.Request(url, data=b"", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=COMMAND_TIMEOUT) as response:
            return {"ok": 200 <= response.status < 300, "status": response.status}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "status": exc.code, "detail": exc.reason}
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}


def notify_event(event: str, payload: dict[str, Any]) -> None:
    channels = RUNTIME_CONFIG.get("alert_channels") or {}
    if event not in channels.get("enabled_events", []):
        return
    webhook_url = channels.get("webhook_url")
    if not webhook_url:
        return
    body = json.dumps({"event": event, "payload": payload}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(webhook_url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=min(COMMAND_TIMEOUT, 5)).read()
    except Exception:
        pass


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
        if AUTH_SHADOW_FALLBACK and authenticate_shadow_user(username, password):
            return
        raise HTTPException(status_code=503, detail="PAM authentication is not available in this runtime") from exc
    try:
        pamela.authenticate(username, password)
    except Exception as exc:
        if AUTH_SHADOW_FALLBACK and authenticate_shadow_user(username, password):
            return
        raise HTTPException(status_code=401, detail="Invalid OS username or password") from exc


def authenticate_shadow_user(username: str, password: str) -> bool:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", username):
        return False
    try:
        import crypt
        import pwd
        import spwd
    except ImportError:
        return False
    try:
        pwd.getpwnam(username)
        shadow_hash = spwd.getspnam(username).sp_pwdp
    except Exception:
        return False
    if not shadow_hash or shadow_hash[0] in {"!", "*"}:
        return False
    try:
        checked = crypt.crypt(password, shadow_hash)
    except Exception:
        return False
    return bool(checked) and hmac.compare_digest(checked, shadow_hash)


def pam_available() -> bool:
    try:
        import pamela  # noqa: F401
    except ImportError:
        return False
    return True


def shadow_fallback_available() -> bool:
    if not AUTH_SHADOW_FALLBACK:
        return False
    try:
        import crypt  # noqa: F401
        import spwd  # noqa: F401
    except ImportError:
        return False
    return os.access("/etc/shadow", os.R_OK)


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
    audit("auth.login", request.username, {"auth_mode": AUTH_MODE})
    return {"authenticated": True, "username": request.username, "auth_mode": AUTH_MODE}


@app.post("/api/auth/logout")
def logout(response: Response, d_aquila_session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    username = session_user(d_aquila_session)
    if d_aquila_session:
        SESSIONS.pop(d_aquila_session, None)
    response.delete_cookie(SESSION_COOKIE)
    audit("auth.logout", username, {})
    return {"authenticated": False}


@app.get("/api/auth/me")
def me(d_aquila_session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    username = session_user(d_aquila_session)
    return {
        "authenticated": bool(username),
        "username": username,
        "auth_mode": AUTH_MODE,
        "role": user_role(username),
    }


SLURM_COMMANDS = {"sinfo", "squeue", "scontrol", "sbatch", "scancel"}


def run_subprocess(args: list[str], timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=False,
        text=True,
        capture_output=True,
        timeout=timeout or COMMAND_TIMEOUT,
    )


def host_slurm_command(args: list[str]) -> list[str] | None:
    if not HOST_SLURM_FALLBACK or not args or args[0] not in SLURM_COMMANDS:
        return None
    chroot = shutil.which("chroot") or "/usr/sbin/chroot"
    if not Path(chroot).exists() and not shutil.which("chroot"):
        return None
    command = args[0]
    for host_path in [f"/usr/bin/{command}", f"/usr/sbin/{command}", f"/bin/{command}", f"/sbin/{command}"]:
        if Path("/host", host_path.lstrip("/")).exists():
            return [chroot, "/host", host_path, *args[1:]]
    return None


def command_error(args: list[str], proc: subprocess.CompletedProcess[str]) -> HTTPException:
    detail = proc.stderr.strip() or proc.stdout.strip() or f"exit code {proc.returncode}"
    return HTTPException(status_code=502, detail=f"{args[0]} failed: {detail}")


def run_command(args: list[str]) -> str:
    try:
        proc = run_subprocess(args)
    except FileNotFoundError as exc:
        fallback = host_slurm_command(args)
        if not fallback:
            raise HTTPException(status_code=503, detail=f"Command not found: {args[0]}") from exc
        try:
            host_proc = run_subprocess(fallback)
        except (FileNotFoundError, subprocess.TimeoutExpired) as host_exc:
            raise HTTPException(status_code=503, detail=f"Host Slurm fallback failed: {host_exc}") from host_exc
        if host_proc.returncode != 0:
            raise command_error(args, host_proc)
        return host_proc.stdout
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"Command timed out: {' '.join(args)}") from exc

    if proc.returncode != 0:
        fallback = host_slurm_command(args)
        if fallback:
            try:
                host_proc = run_subprocess(fallback)
            except (FileNotFoundError, subprocess.TimeoutExpired) as host_exc:
                raise HTTPException(status_code=503, detail=f"Host Slurm fallback failed: {host_exc}") from host_exc
            if host_proc.returncode == 0:
                return host_proc.stdout
            raise command_error(args, host_proc)
        raise command_error(args, proc)
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
    url = f"{prometheus_base_url()}{path}"
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
        value = float(result[0]["value"][1])
        return value if math.isfinite(value) else default
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
    filesystems: list[dict[str, Any]] = []
    host_paths = [
        ("root", "/host"),
        ("home", "/host/home"),
        ("data", "/host/data"),
        ("data1", "/host/data1"),
        ("data2", "/host/data2"),
    ]
    seen_devices: set[str] = set()
    for label, mountpoint in host_paths:
        if not Path(mountpoint).exists():
            continue
        try:
            usage = psutil.disk_usage(mountpoint)
        except (PermissionError, OSError):
            continue
        device = label
        for partition in psutil.disk_partitions(all=False):
            if partition.mountpoint == mountpoint:
                device = partition.device
                break
        key = f"{usage.total}:{usage.free}:{mountpoint}"
        if key in seen_devices:
            continue
        seen_devices.add(key)
        filesystems.append(
            {
                "device": device,
                "mountpoint": "/" if mountpoint == "/host" else mountpoint.removeprefix("/host"),
                "label": label,
                "fstype": "",
                "total_bytes": usage.total,
                "used_bytes": usage.used,
                "free_bytes": usage.free,
                "usage_percent": round(usage.percent, 1),
            }
        )
    return filesystems


def local_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def configured_site_location() -> dict[str, str]:
    return {
        "name": SITE_NAME,
        "facility": SITE_FACILITY,
        "latitude": SITE_LATITUDE,
        "longitude": SITE_LONGITUDE,
        "source": "configured" if any([SITE_NAME, SITE_FACILITY, SITE_LATITUDE, SITE_LONGITUDE]) else "",
    }


def site_location() -> dict[str, str]:
    configured = configured_site_location()
    if configured["source"] or not SITE_AUTO:
        return configured
    now = time.time()
    if SITE_CACHE.get("value") and float(SITE_CACHE.get("expires_at", 0)) > now:
        return SITE_CACHE["value"]

    detected = detect_public_ip_location()
    SITE_CACHE["value"] = detected
    SITE_CACHE["expires_at"] = now + 6 * 60 * 60
    return detected


def detect_public_ip_location() -> dict[str, str]:
    providers = [
        ("https://ipapi.co/json/", parse_ipapi_location),
        ("http://ip-api.com/json/?fields=status,message,country,regionName,city,lat,lon,query,org", parse_ip_api_location),
    ]
    for url, parser in providers:
        try:
            with urllib.request.urlopen(url, timeout=min(COMMAND_TIMEOUT, 3)) as response:
                payload = json.loads(response.read().decode("utf-8"))
            parsed = parser(payload)
            if parsed.get("name"):
                return parsed
        except Exception:
            continue
    return {"name": "", "facility": "", "latitude": "", "longitude": "", "source": "unavailable"}


def parse_ipapi_location(payload: dict[str, Any]) -> dict[str, str]:
    city = str(payload.get("city") or "")
    region = str(payload.get("region") or payload.get("region_code") or "")
    country = str(payload.get("country_name") or payload.get("country") or "")
    name = ", ".join(part for part in [city, region, country] if part)
    return {
        "name": name,
        "facility": str(payload.get("org") or payload.get("asn") or ""),
        "latitude": str(payload.get("latitude") or ""),
        "longitude": str(payload.get("longitude") or ""),
        "public_ip": str(payload.get("ip") or ""),
        "source": "auto-ipapi",
    }


def parse_ip_api_location(payload: dict[str, Any]) -> dict[str, str]:
    if payload.get("status") == "fail":
        return {"name": "", "facility": "", "latitude": "", "longitude": "", "source": "unavailable"}
    city = str(payload.get("city") or "")
    region = str(payload.get("regionName") or "")
    country = str(payload.get("country") or "")
    name = ", ".join(part for part in [city, region, country] if part)
    return {
        "name": name,
        "facility": str(payload.get("org") or ""),
        "latitude": str(payload.get("lat") or ""),
        "longitude": str(payload.get("lon") or ""),
        "public_ip": str(payload.get("query") or ""),
        "source": "auto-ip-api",
    }


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


def parse_memory_gb(value: str) -> float:
    text = str(value or "").strip().lower()
    match = re.match(r"^(\d+(?:\.\d+)?)([kmgtp]?)b?$", text)
    if not match:
        return 0.0
    number = float(match.group(1))
    unit = match.group(2)
    factors = {"": 1 / 1024, "k": 1 / (1024 * 1024), "m": 1 / 1024, "g": 1, "t": 1024, "p": 1024 * 1024}
    return number * factors.get(unit, 1)


def parse_time_hours(value: str) -> float:
    text = str(value or "").strip()
    days = 0
    if "-" in text:
        day_text, text = text.split("-", 1)
        if day_text.isdigit():
            days = int(day_text)
    parts = [int(part) for part in text.split(":") if part.isdigit()]
    if len(parts) == 3:
        hours, minutes, seconds = parts
    elif len(parts) == 2:
        hours, minutes, seconds = 0, parts[0], parts[1]
    elif len(parts) == 1:
        hours, minutes, seconds = 0, parts[0], 0
    else:
        hours, minutes, seconds = 0, 0, 0
    return days * 24 + hours + minutes / 60 + seconds / 3600


def enforce_submit_policy(request: SubmitRequest) -> None:
    policy = RUNTIME_CONFIG.get("job_policy") or default_policy()
    if not policy.get("enabled", ENABLE_SUBMIT):
        raise HTTPException(
            status_code=403,
            detail="Job submission is disabled in D-aquila policy.",
        )
    allowed = [item.strip() for item in policy.get("allowed_partitions", []) if item.strip()]
    if allowed and request.partition not in allowed:
        raise HTTPException(status_code=403, detail=f"Partition '{request.partition}' is not allowed by policy.")
    if request.cpu > int(policy.get("max_cpu", 64)):
        raise HTTPException(status_code=403, detail=f"CPU request exceeds policy limit: {policy.get('max_cpu')}")
    if request.gpu > int(policy.get("max_gpu", 8)):
        raise HTTPException(status_code=403, detail=f"GPU request exceeds policy limit: {policy.get('max_gpu')}")
    if parse_memory_gb(request.memory) > float(policy.get("max_memory_gb", 256)):
        raise HTTPException(status_code=403, detail=f"Memory request exceeds policy limit: {policy.get('max_memory_gb')}G")
    if parse_time_hours(request.time) > float(policy.get("max_time_hours", 24)):
        raise HTTPException(status_code=403, detail=f"Time request exceeds policy limit: {policy.get('max_time_hours')}h")


def parse_target_lines(items: list[str]) -> list[str]:
    targets: list[str] = []
    for item in items:
        for part in str(item).replace(",", "\n").splitlines():
            target = part.strip()
            if target:
                targets.append(target)
    return sorted(set(targets))


def prometheus_test(url: str) -> dict[str, Any]:
    clean = url.rstrip("/")
    try:
        with urllib.request.urlopen(f"{clean}/api/v1/status/runtimeinfo", timeout=COMMAND_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}
    return {"ok": payload.get("status") == "success", "detail": payload.get("status", "unknown")}


def prom_vector(query: str) -> list[dict[str, Any]]:
    try:
        data = prometheus("/api/v1/query", {"query": query})
        return data.get("result", [])
    except HTTPException:
        return []


def prom_series_value(query: str) -> list[dict[str, Any]]:
    rows = []
    for item in prom_vector(query):
        metric = item.get("metric", {})
        value = item.get("value", [None, None])[1]
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            numeric = None
        if numeric is not None and not math.isfinite(numeric):
            numeric = None
        rows.append({"metric": metric, "value": numeric})
    return rows


def node_exporter_usage_by_name() -> dict[str, dict[str, float]]:
    uname_rows = prom_series_value("node_uname_info")
    instance_to_name: dict[str, str] = {}
    usage: dict[str, dict[str, float]] = {}
    for row in uname_rows:
        metric = row.get("metric", {})
        instance = str(metric.get("instance") or "")
        name = str(metric.get("nodename") or metric.get("hostname") or "").split(".")[0]
        if instance and name:
            instance_to_name[instance] = name
            usage.setdefault(name, {})

    cpu_rows = prom_series_value('100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)')
    for row in cpu_rows:
        instance = str(row.get("metric", {}).get("instance") or "")
        name = instance_to_name.get(instance)
        value = row.get("value")
        if name and isinstance(value, (int, float)):
            usage.setdefault(name, {})["cpu_usage_percent"] = round(value, 1)

    mem_rows = prom_series_value("100 * (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))")
    for row in mem_rows:
        instance = str(row.get("metric", {}).get("instance") or "")
        name = instance_to_name.get(instance)
        value = row.get("value")
        if name and isinstance(value, (int, float)):
            usage.setdefault(name, {})["memory_usage_percent"] = round(value, 1)
    return usage


def read_audit(limit: int) -> list[dict[str, Any]]:
    if not AUDIT_LOG_PATH.exists():
        return []
    try:
        lines = AUDIT_LOG_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    rows = []
    for line in lines[-limit:]:
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return list(reversed(rows))


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "prometheus_url": prometheus_base_url(),
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
            "url": prometheus_base_url(),
            "ready": prometheus_ready,
            "targets_by_job": prometheus_targets,
        },
        "submit_enabled": bool((RUNTIME_CONFIG.get("job_policy") or {}).get("enabled", ENABLE_SUBMIT)),
        "job_policy": RUNTIME_CONFIG.get("job_policy") or default_policy(),
        "auth": {
            "mode": AUTH_MODE,
            "pam_available": pam_available(),
            "shadow_fallback_enabled": AUTH_SHADOW_FALLBACK,
            "shadow_fallback_available": shadow_fallback_available(),
            "session_seconds": AUTH_SESSION_SECONDS,
        },
        "runtime": {
            "disk_path": os.getenv("D_AQUILA_DISK_PATH", "/"),
            "command_timeout": COMMAND_TIMEOUT,
            "host_slurm_fallback": HOST_SLURM_FALLBACK,
        },
    }


@app.get("/api/summary")
def summary() -> dict[str, Any]:
    cpu_alloc = prom_value("sum(slurm_cpus_alloc)")
    cpu_total = prom_value("sum(slurm_cpus_total)")
    cluster_cpu_avg = prom_value('avg(100 - (rate(node_cpu_seconds_total{mode="idle"}[5m]) * 100))', -1)
    cluster_core_total = prom_value('count(node_cpu_seconds_total{mode="idle"})', 0)
    cluster_memory_total = prom_value("sum(node_memory_MemTotal_bytes)", 0)
    cluster_memory_available = prom_value("sum(node_memory_MemAvailable_bytes)", 0)
    gpu_avg = prom_value("avg(DCGM_FI_DEV_GPU_UTIL)", -1)
    gpu_used = prom_value("count(DCGM_FI_DEV_GPU_UTIL > 0)")
    gpu_total = prom_value("count(DCGM_FI_DEV_GPU_UTIL)")
    cpu_usage = cluster_cpu_avg if cluster_cpu_avg >= 0 else ((cpu_alloc / cpu_total * 100) if cpu_total else 0)
    return {
        "cpu_alloc": cpu_alloc,
        "cpu_total": cluster_core_total or cpu_total,
        "slurm_cpu_total": cpu_total,
        "cluster_core_total": cluster_core_total or cpu_total,
        "cluster_memory_total_bytes": cluster_memory_total,
        "cluster_memory_used_bytes": max(cluster_memory_total - cluster_memory_available, 0) if cluster_memory_total else 0,
        "cluster_memory_usage_percent": (100 * (1 - cluster_memory_available / cluster_memory_total)) if cluster_memory_total else 0,
        "cpu_usage_percent": cpu_usage,
        "cluster_cpu_usage_percent": cpu_usage,
        "gpu_used": gpu_used,
        "gpu_total": gpu_total,
        "gpu_usage_percent": gpu_avg if gpu_avg >= 0 else ((gpu_used / gpu_total * 100) if gpu_total else 0),
        "cluster_gpu_usage_percent": gpu_avg if gpu_avg >= 0 else ((gpu_used / gpu_total * 100) if gpu_total else 0),
        "jobs_running": prom_value("sum(slurm_queue_running)"),
        "jobs_pending": prom_value("sum(slurm_queue_pending)"),
        "nodes_down": prom_value("sum(slurm_nodes_down)"),
        "max_gpu_temp_celsius": prom_value("max(DCGM_FI_DEV_GPU_TEMP)"),
        "gpu_power_watts": prom_value("sum(DCGM_FI_DEV_POWER_USAGE)"),
        "ipmi_up": prom_value('sum(up{job="ipmi"})'),
        "site": site_location(),
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


@app.get("/api/ipmi")
def ipmi_details() -> dict[str, Any]:
    targets_data = {"targets": []}
    try:
        targets_data = targets()
    except HTTPException:
        targets_data = {"targets": []}
    ipmi_targets = [target for target in targets_data.get("targets", []) if "ipmi" in target.get("job", "").lower()]
    sensor_rows = prom_series_value('ipmi_sensor_value')
    sensors = []
    inlet = []
    power = []
    for row in sensor_rows:
        metric = row.get("metric", {})
        value = row.get("value")
        name = str(metric.get("name") or metric.get("sensor") or metric.get("id") or "").lower()
        sensor_type = str(metric.get("type") or "").lower()
        instance = str(metric.get("instance") or "")
        item = {
            "instance": instance,
            "name": metric.get("name") or metric.get("sensor") or metric.get("id") or "-",
            "type": metric.get("type") or "-",
            "value": value,
        }
        sensors.append(item)
        if value is None:
            continue
        if "temp" in sensor_type or "temp" in name:
            if any(word in name for word in ["inlet", "intake", "ambient", "front"]):
                inlet.append(item)
        if "power" in sensor_type or "watt" in name or "pwr" in name or "power" in name:
            power.append(item)

    return {
        "targets": ipmi_targets,
        "sensors": sensors[:200],
        "inlet_temperatures": inlet[:80],
        "power_readings": power[:80],
        "summary": {
            "targets": len(ipmi_targets),
            "up": sum(1 for target in ipmi_targets if target.get("health") == "up"),
            "inlet_max": max([item["value"] for item in inlet if item.get("value") is not None], default=None),
            "power_sum": sum(item["value"] for item in power if item.get("value") is not None),
        },
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


@app.get("/api/audit")
def audit_logs(limit: int = 120) -> dict[str, Any]:
    safe_limit = max(20, min(limit, 500))
    rows = read_audit(safe_limit)
    return {
        "audit": rows,
        "summary": {
            "total": len(rows),
            "failed": sum(1 for item in rows if item.get("status") != "ok"),
            "users": len({item.get("user") for item in rows if item.get("user")}),
        },
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
def jobs(user: str | None = None, state: str | None = None) -> dict[str, Any]:
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
        row = {
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
        if user and row["user"] != user:
            continue
        if state and row["status"] != state:
            continue
        rows.append(row)
    return {"jobs": rows}


@app.get("/api/nodes")
def nodes() -> dict[str, Any]:
    output = run_command(["scontrol", "show", "node", "-o"])
    rows = []
    exporter_usage = node_exporter_usage_by_name()
    for line in output.splitlines():
        item = parse_kv_line(line)
        if not item.get("NodeName"):
            continue
        node_name = item.get("NodeName", "")
        usage = exporter_usage.get(node_name.split(".")[0], {})
        state = item.get("State", "")
        is_login = node_name.lower().startswith("login")
        display_state = "MONITORED" if is_login and usage else state
        cfg_tres = item.get("CfgTRES", "")
        alloc_tres = item.get("AllocTRES", "")
        rows.append(
            {
                "name": node_name,
                "addr": item.get("NodeAddr", ""),
                "hostname": item.get("NodeHostName", ""),
                "state": display_state,
                "slurm_state": state,
                "partitions": item.get("Partitions", ""),
                "gres": item.get("Gres", ""),
                "cpu_alloc": int(item.get("CPUAlloc", "0") or 0),
                "cpu_total": int(item.get("CPUTot", "0") or 0),
                "cpu_load": float(item.get("CPULoad", "0") or 0),
                "cpu_usage_percent": usage.get("cpu_usage_percent"),
                "memory_usage_percent": usage.get("memory_usage_percent"),
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
def submit_job(request: SubmitRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin", "operator"})
    enforce_submit_policy(request)

    with tempfile.NamedTemporaryFile("w", suffix=".sbatch", prefix="d-aquila-", delete=False) as handle:
        handle.write(request.script)
        script_path = handle.name

    try:
        output = run_command(["sbatch", script_path])
        audit("job.submit", user, {"name": request.name, "partition": request.partition, "cpu": request.cpu, "gpu": request.gpu}, "ok")
        notify_event("job.submit", {"user": user, "name": request.name, "partition": request.partition})
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass

    match = re.search(r"Submitted batch job (\S+)", output)
    return {"submitted": True, "job_id": match.group(1) if match else None, "output": output.strip()}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, request: JobCancelRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin", "operator"})
    if not re.match(r"^[A-Za-z0-9_.-]+$", job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")
    output = run_command(["scancel", job_id])
    audit("job.cancel", user, {"job_id": job_id, "reason": request.reason}, "ok")
    notify_event("job.cancel", {"user": user, "job_id": job_id, "reason": request.reason})
    return {"cancelled": True, "job_id": job_id, "output": output.strip()}


@app.get("/api/job-policy")
def get_job_policy() -> dict[str, Any]:
    return {"policy": RUNTIME_CONFIG.get("job_policy") or default_policy()}


@app.post("/api/job-policy")
def set_job_policy(request: JobPolicyRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin"})
    policy = request.model_dump() if hasattr(request, "model_dump") else request.dict()
    policy["allowed_partitions"] = sorted(set(item.strip() for item in policy["allowed_partitions"] if item.strip()))
    RUNTIME_CONFIG["job_policy"] = policy
    save_runtime_config()
    audit("policy.update", user, policy, "ok")
    return {"policy": policy}


@app.get("/api/prometheus/config")
def get_prometheus_config() -> dict[str, Any]:
    config = RUNTIME_CONFIG.get("prometheus") or {"url": prometheus_base_url()}
    return {"prometheus": {"url": prometheus_base_url(), **config}}


@app.post("/api/prometheus/config")
def set_prometheus_config(request: PrometheusConfigRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin", "operator"})
    config = {
        "url": request.url.rstrip("/"),
        "node_targets": parse_target_lines(request.node_targets),
        "dcgm_targets": parse_target_lines(request.dcgm_targets),
        "ipmi_targets": parse_target_lines(request.ipmi_targets),
    }
    RUNTIME_CONFIG["prometheus"] = config
    written = write_file_sd_config(config)
    save_runtime_config()
    result = prometheus_test(config["url"])
    audit("prometheus.update", user, {**config, "written": written, "test": result}, "ok" if result["ok"] else "warn")
    return {"prometheus": config, "written": written, "test": result}


@app.post("/api/prometheus/test")
def test_prometheus_config(request: PrometheusConfigRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin", "operator"})
    result = prometheus_test(request.url)
    audit("prometheus.test", user, {"url": request.url, "result": result}, "ok" if result["ok"] else "warn")
    return {"test": result}


@app.post("/api/prometheus/apply")
def apply_prometheus_config(username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin", "operator"})
    config = RUNTIME_CONFIG.get("prometheus") or {"url": prometheus_base_url()}
    written = write_file_sd_config(config)
    reload_result = reload_prometheus()
    status = "ok" if reload_result.get("ok") else "warn"
    audit("prometheus.apply", user, {"written": written, "reload": reload_result}, status)
    return {"written": written, "reload": reload_result}


@app.get("/api/access-model")
def get_access_model(username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    return {"access_model": RUNTIME_CONFIG.get("access_model") or default_access_model(), "current_role": user_role(user)}


@app.post("/api/access-model")
def set_access_model(request: AccessModelRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin"})
    model = request.model_dump() if hasattr(request, "model_dump") else request.dict()
    for key, value in list(model.items()):
        model[key] = sorted(set(item.strip() for item in value if item.strip()))
    RUNTIME_CONFIG["access_model"] = model
    save_runtime_config()
    audit("access.update", user, model, "ok")
    return {"access_model": model}


@app.get("/api/job-templates")
def get_job_templates() -> dict[str, Any]:
    return {"templates": RUNTIME_CONFIG.get("job_templates") or default_templates()}


@app.post("/api/job-templates")
def save_job_template(request: JobTemplateRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin", "operator"})
    template = request.model_dump() if hasattr(request, "model_dump") else request.dict()
    template["id"] = slug(template["name"])
    templates = [item for item in RUNTIME_CONFIG.get("job_templates", []) if item.get("id") != template["id"]]
    templates.append(template)
    RUNTIME_CONFIG["job_templates"] = sorted(templates, key=lambda item: item.get("name", ""))
    save_runtime_config()
    audit("template.save", user, {"template_id": template["id"], "name": template["name"]}, "ok")
    return {"template": template, "templates": RUNTIME_CONFIG["job_templates"]}


@app.get("/api/approvals")
def get_approvals() -> dict[str, Any]:
    return {"approvals": RUNTIME_CONFIG.get("approvals") or []}


@app.post("/api/approvals")
def request_approval(request: ApprovalRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    template = next((item for item in RUNTIME_CONFIG.get("job_templates", []) if item.get("id") == request.template_id), None)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    approval = {
        "id": secrets.token_hex(8),
        "template_id": request.template_id,
        "template_name": template.get("name"),
        "requester": user,
        "status": "pending",
        "parameters": request.parameters,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    RUNTIME_CONFIG.setdefault("approvals", []).insert(0, approval)
    save_runtime_config()
    audit("approval.request", user, {"approval_id": approval["id"], "template_id": request.template_id}, "ok")
    notify_event("approval.request", approval)
    return {"approval": approval}


@app.post("/api/approvals/{approval_id}/decision")
def decide_approval(approval_id: str, request: ApprovalDecisionRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin", "operator"})
    if request.action not in {"approve", "reject"}:
        raise HTTPException(status_code=400, detail="Action must be approve or reject")
    approvals = RUNTIME_CONFIG.get("approvals") or []
    approval = next((item for item in approvals if item.get("id") == approval_id), None)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval not found")
    if approval.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Approval is already decided")
    approval["status"] = "approved" if request.action == "approve" else "rejected"
    approval["reviewer"] = user
    approval["comment"] = request.comment
    approval["decided_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    save_runtime_config()
    audit("approval.decision", user, {"approval_id": approval_id, "action": request.action}, "ok")
    notify_event("approval.decision", approval)
    return {"approval": approval}


@app.get("/api/facility-layout")
def get_facility_layout() -> dict[str, Any]:
    return {"facility_layout": RUNTIME_CONFIG.get("facility_layout") or default_facility_layout()}


@app.post("/api/facility-layout")
def set_facility_layout(request: FacilityLayoutRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin", "operator"})
    layout = request.model_dump() if hasattr(request, "model_dump") else request.dict()
    RUNTIME_CONFIG["facility_layout"] = layout
    save_runtime_config()
    audit("facility.update", user, {"rooms": len(layout.get("rooms", [])), "racks": len(layout.get("racks", []))}, "ok")
    return {"facility_layout": layout}


@app.get("/api/alert-channels")
def get_alert_channels() -> dict[str, Any]:
    return {"alert_channels": RUNTIME_CONFIG.get("alert_channels") or {}}


@app.post("/api/alert-channels")
def set_alert_channels(request: AlertChannelsRequest, username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin", "operator"})
    channels = request.model_dump() if hasattr(request, "model_dump") else request.dict()
    channels["email_recipients"] = sorted(set(item.strip() for item in channels.get("email_recipients", []) if item.strip()))
    channels["enabled_events"] = sorted(set(item.strip() for item in channels.get("enabled_events", []) if item.strip()))
    RUNTIME_CONFIG["alert_channels"] = channels
    save_runtime_config()
    audit("alerts.update", user, {"enabled_events": channels["enabled_events"], "webhook": bool(channels.get("webhook_url"))}, "ok")
    return {"alert_channels": channels}


@app.post("/api/alert-channels/test")
def test_alert_channels(username: str = Cookie(default=None, alias=SESSION_COOKIE)) -> dict[str, Any]:
    user = session_user(username)
    require_role(user, {"admin", "operator"})
    payload = {"message": "D-aquila alert channel test", "user": user, "time": datetime.now().astimezone().isoformat(timespec="seconds")}
    notify_event("alert.test", payload)
    audit("alerts.test", user, payload, "ok")
    return {"sent": True}


app.mount("/", StaticFiles(directory=ROOT, html=True), name="static")
