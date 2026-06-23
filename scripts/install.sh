#!/usr/bin/env bash
set -euo pipefail

APP_NAME="d-aquila"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${D_AQUILA_INSTALL_DIR:-/opt/d-aquila}"
PROMETHEUS_URL="${D_AQUILA_PROMETHEUS_URL:-http://localhost:9090}"
ENABLE_SUBMIT="${D_AQUILA_ENABLE_SUBMIT:-false}"

log() {
  printf '[%s] %s\n' "$APP_NAME" "$*"
}

die() {
  printf '[%s] ERROR: %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "Run as root or with sudo for one-click installation."
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi

  log "Docker not found. Installing Docker Engine."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ca-certificates curl
    curl -fsSL https://get.docker.com | sh
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl
    curl -fsSL https://get.docker.com | sh
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl
    curl -fsSL https://get.docker.com | sh
  else
    die "Unsupported Linux distribution. Install Docker, then rerun this script."
  fi

  systemctl enable --now docker || true
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return
  fi
  die "Docker Compose is not available after Docker installation."
}

detect_prometheus() {
  for url in "$PROMETHEUS_URL" "http://localhost:9090" "http://127.0.0.1:9090"; do
    if curl -fsS "$url/-/ready" >/dev/null 2>&1; then
      PROMETHEUS_URL="$url"
      log "Detected Prometheus at $PROMETHEUS_URL"
      return
    fi
  done
  log "Prometheus was not auto-detected. Using $PROMETHEUS_URL"
}

preflight() {
  log "Running preflight checks."
  command -v curl >/dev/null 2>&1 || die "curl is required."

  if [ ! -f "$REPO_ROOT/docker-compose.yml" ] || [ ! -f "$REPO_ROOT/Dockerfile" ]; then
    die "Could not find d-aquila project root. Run this script from a complete git clone."
  fi

  if command -v squeue >/dev/null 2>&1; then
    log "Detected Slurm client on host."
  else
    log "Slurm client not found on host. The container image includes slurm-client, but host Slurm config must be mounted."
  fi

  if [ -d /etc/slurm ] || [ -d /etc/slurm-llnl ]; then
    log "Detected Slurm configuration directory."
  else
    log "No /etc/slurm or /etc/slurm-llnl found. Mount or provide Slurm config before expecting Slurm APIs to work."
  fi

  if [ -S /run/munge/munge.socket.2 ] || [ -S /var/run/munge/munge.socket.2 ]; then
    log "Detected Munge socket."
  else
    log "Munge socket not detected. Read-only Slurm commands may fail until Munge is available."
  fi

  detect_prometheus
}

install_files() {
  log "Installing files from $REPO_ROOT to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"

  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude .git \
      --exclude .agents \
      --exclude .venv \
      "$REPO_ROOT/" "$INSTALL_DIR/"
  else
    (cd "$REPO_ROOT" && tar \
        --exclude .git \
        --exclude .agents \
        --exclude .venv \
        -cf - .) | tar -C "$INSTALL_DIR" -xf -
  fi
}

write_env() {
  cat > "$INSTALL_DIR/.env" <<EOF
D_AQUILA_PROMETHEUS_URL=$PROMETHEUS_URL
D_AQUILA_ENABLE_SUBMIT=$ENABLE_SUBMIT
D_AQUILA_COMMAND_TIMEOUT=${D_AQUILA_COMMAND_TIMEOUT:-10}
EOF
}

start_app() {
  local compose
  compose="$(compose_cmd)"
  log "Building and starting d-aquila."
  cd "$INSTALL_DIR"
  $compose up -d --build
}

main() {
  need_root
  install_docker
  preflight
  install_files
  write_env
  start_app
  log "Installation complete."
  log "Open http://<login-node>:8000"
}

main "$@"
