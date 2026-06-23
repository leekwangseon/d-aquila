#!/usr/bin/env bash
set -euo pipefail

APP_NAME="D-aquila"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GENERATED_DIR="${D_AQUILA_GENERATED_DIR:-$REPO_ROOT/generated}"
FILE_SD_DIR="$GENERATED_DIR/prometheus/file_sd"
REPORT_DIR="$GENERATED_DIR/exporters"
MODE="${1:-${D_AQUILA_EXPORTER_MODE:-plan}}"
SSH_USER="${D_AQUILA_EXPORTER_SSH_USER:-root}"
SSH_OPTS="${D_AQUILA_EXPORTER_SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new}"
NODE_EXPORTER_VERSION="${D_AQUILA_NODE_EXPORTER_VERSION:-1.8.2}"
NODE_EXPORTER_PORT="${D_AQUILA_NODE_EXPORTER_PORT:-9100}"
DCGM_EXPORTER_PORT="${D_AQUILA_DCGM_EXPORTER_PORT:-9400}"
DCGM_EXPORTER_IMAGE="${D_AQUILA_DCGM_EXPORTER_IMAGE:-nvcr.io/nvidia/k8s/dcgm-exporter:3.3.8-3.6.0-ubuntu22.04}"

log() {
  printf '[%s] %s\n' "$APP_NAME" "$*"
}

die() {
  printf '[%s] ERROR: %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: scripts/setup-exporters.sh [plan|generate-scripts|deploy]

Modes:
  plan              Detect nodes and generate reports/file_sd targets only.
  generate-scripts  Generate reports, file_sd targets, and reusable installer scripts.
  deploy            Generate everything and SSH deploy exporters to detected nodes.

Environment:
  D_AQUILA_EXPORTER_SSH_USER=root
  D_AQUILA_NODE_EXPORTER_VERSION=$NODE_EXPORTER_VERSION
  D_AQUILA_DCGM_EXPORTER_IMAGE=$DCGM_EXPORTER_IMAGE
EOF
}

normalize_mode() {
  case "$MODE" in
    --plan|plan) MODE="plan" ;;
    --generate-scripts|generate-scripts|scripts) MODE="generate-scripts" ;;
    --deploy|deploy) MODE="deploy" ;;
    -h|--help|help) usage; exit 0 ;;
    *) die "Unknown exporter setup mode: $MODE" ;;
  esac
}

remote() {
  local node="$1"
  shift
  ssh $SSH_OPTS "${SSH_USER}@${node}" "$@"
}

detect_nodes() {
  mkdir -p "$REPORT_DIR"
  local raw="$REPORT_DIR/scontrol-nodes.txt"
  : > "$REPORT_DIR/all-nodes.txt"
  : > "$REPORT_DIR/gpu-nodes.txt"
  : > "$REPORT_DIR/cpu-nodes.txt"

  if command -v scontrol >/dev/null 2>&1; then
    scontrol show node -o > "$raw" || true
  else
    : > "$raw"
  fi

  if [ ! -s "$raw" ]; then
    log "Slurm nodes were not detected. Falling back to standalone localhost mode."
    printf 'localhost\n' > "$REPORT_DIR/all-nodes.txt"
    printf 'localhost\n' > "$REPORT_DIR/cpu-nodes.txt"
    return
  fi

  while IFS= read -r line; do
    local node gpu_total gres cfg_tres
    node="$(printf '%s\n' "$line" | sed -n 's/.*NodeName=\([^ ]*\).*/\1/p')"
    gres="$(printf '%s\n' "$line" | sed -n 's/.*Gres=\([^ ]*\).*/\1/p')"
    cfg_tres="$(printf '%s\n' "$line" | sed -n 's/.*CfgTRES=\([^ ]*\).*/\1/p')"
    [ -n "$node" ] || continue
    printf '%s\n' "$node" >> "$REPORT_DIR/all-nodes.txt"
    gpu_total=0
    if printf '%s %s\n' "$gres" "$cfg_tres" | grep -Eq 'gpu(:|=|/gpu=)[^, ]*[0-9]|gres/gpu=[1-9]'; then
      gpu_total=1
    fi
    if [ "$gpu_total" -eq 1 ]; then
      printf '%s\n' "$node" >> "$REPORT_DIR/gpu-nodes.txt"
    else
      printf '%s\n' "$node" >> "$REPORT_DIR/cpu-nodes.txt"
    fi
  done < "$raw"

  sort -u -o "$REPORT_DIR/all-nodes.txt" "$REPORT_DIR/all-nodes.txt"
  sort -u -o "$REPORT_DIR/gpu-nodes.txt" "$REPORT_DIR/gpu-nodes.txt"
  sort -u -o "$REPORT_DIR/cpu-nodes.txt" "$REPORT_DIR/cpu-nodes.txt"
}

json_targets() {
  local input="$1"
  local port="$2"
  local label="$3"
  local output="$4"
  mkdir -p "$(dirname "$output")"
  {
    printf '[\n'
    printf '  {\n'
    printf '    "labels": {"d_aquila_role": "%s"},\n' "$label"
    printf '    "targets": [\n'
    local first=1
    while IFS= read -r node; do
      [ -n "$node" ] || continue
      if [ "$first" -eq 0 ]; then
        printf ',\n'
      fi
      first=0
      printf '      "%s:%s"' "$node" "$port"
    done < "$input"
    printf '\n    ]\n'
    printf '  }\n'
    printf ']\n'
  } > "$output"
}

write_plan() {
  mkdir -p "$FILE_SD_DIR" "$REPORT_DIR"
  json_targets "$REPORT_DIR/all-nodes.txt" "$NODE_EXPORTER_PORT" "node" "$FILE_SD_DIR/node-exporter.json"
  json_targets "$REPORT_DIR/gpu-nodes.txt" "$DCGM_EXPORTER_PORT" "gpu" "$FILE_SD_DIR/dcgm-exporter.json"
  if [ ! -f "$FILE_SD_DIR/ipmi-exporter.json" ]; then
    printf '[]\n' > "$FILE_SD_DIR/ipmi-exporter.json"
  fi

  local total cpu gpu
  total="$(wc -l < "$REPORT_DIR/all-nodes.txt" | tr -d ' ')"
  cpu="$(wc -l < "$REPORT_DIR/cpu-nodes.txt" | tr -d ' ')"
  gpu="$(wc -l < "$REPORT_DIR/gpu-nodes.txt" | tr -d ' ')"

  cat > "$REPORT_DIR/install-report.txt" <<EOF
D-aquila exporter setup plan

Nodes:
  Total: $total
  CPU-only nodes: $cpu
  GPU nodes: $gpu

Exporter targets:
  node-exporter: $total nodes, port $NODE_EXPORTER_PORT
  dcgm-exporter: $gpu GPU nodes, port $DCGM_EXPORTER_PORT
  ipmi-exporter: not configured by default

Generated Prometheus file_sd:
  $FILE_SD_DIR/node-exporter.json
  $FILE_SD_DIR/dcgm-exporter.json
  $FILE_SD_DIR/ipmi-exporter.json

Diskless recovery:
  Re-run scripts/install.sh or scripts/setup-exporters.sh deploy after compute nodes reboot.
EOF

  cat > "$REPORT_DIR/exporter-plan.json" <<EOF
{
  "node_exporter": {
    "port": $NODE_EXPORTER_PORT,
    "nodes_file": "$REPORT_DIR/all-nodes.txt"
  },
  "dcgm_exporter": {
    "port": $DCGM_EXPORTER_PORT,
    "nodes_file": "$REPORT_DIR/gpu-nodes.txt",
    "image": "$DCGM_EXPORTER_IMAGE"
  },
  "prometheus_file_sd": "$FILE_SD_DIR"
}
EOF

  log "Exporter plan generated."
  log "Report: $REPORT_DIR/install-report.txt"
}

write_generated_scripts() {
  mkdir -p "$REPORT_DIR/scripts"
  cat > "$REPORT_DIR/scripts/install-node-exporter-remote.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
VERSION="${NODE_EXPORTER_VERSION:-1.8.2}"
PORT="${NODE_EXPORTER_PORT:-9100}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
BASE="/opt/d-aquila-exporters/node-exporter"
URL="https://github.com/prometheus/node_exporter/releases/download/v${VERSION}/node_exporter-${VERSION}.linux-${ARCH}.tar.gz"
mkdir -p "$BASE"
cd "$BASE"
if [ ! -x "$BASE/node_exporter" ]; then
  curl -fsSL "$URL" -o node_exporter.tgz
  tar -xzf node_exporter.tgz --strip-components=1
fi
cat > /etc/systemd/system/node-exporter.service <<SERVICE
[Unit]
Description=D-aquila node-exporter
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$BASE/node_exporter --web.listen-address=:$PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now node-exporter
EOF

  cat > "$REPORT_DIR/scripts/install-dcgm-exporter-remote.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
PORT="${DCGM_EXPORTER_PORT:-9400}"
IMAGE="${DCGM_EXPORTER_IMAGE:-nvcr.io/nvidia/k8s/dcgm-exporter:3.3.8-3.6.0-ubuntu22.04}"
nvidia-smi >/dev/null
if command -v docker >/dev/null 2>&1; then
  docker rm -f dcgm-exporter >/dev/null 2>&1 || true
  docker run -d --name dcgm-exporter --restart unless-stopped --gpus all -p "$PORT:9400" "$IMAGE"
elif command -v podman >/dev/null 2>&1; then
  podman rm -f dcgm-exporter >/dev/null 2>&1 || true
  podman run -d --name dcgm-exporter --restart=always --device nvidia.com/gpu=all -p "$PORT:9400" "$IMAGE"
else
  echo "Docker or Podman is required for automatic dcgm-exporter deployment." >&2
  exit 1
fi
EOF

  chmod +x "$REPORT_DIR/scripts/"*.sh
  log "Generated reusable remote installer scripts in $REPORT_DIR/scripts"
}

ssh_check() {
  local node="$1"
  if [ "$node" = "localhost" ]; then
    return 0
  fi
  remote "$node" "hostname >/dev/null"
}

deploy_node_exporter() {
  local node="$1"
  log "Deploying node-exporter to $node"
  if [ "$node" = "localhost" ]; then
    NODE_EXPORTER_VERSION="$NODE_EXPORTER_VERSION" NODE_EXPORTER_PORT="$NODE_EXPORTER_PORT" bash "$REPORT_DIR/scripts/install-node-exporter-remote.sh"
    return
  fi
  ssh $SSH_OPTS "${SSH_USER}@${node}" "NODE_EXPORTER_VERSION='$NODE_EXPORTER_VERSION' NODE_EXPORTER_PORT='$NODE_EXPORTER_PORT' bash -s" < "$REPORT_DIR/scripts/install-node-exporter-remote.sh"
}

deploy_dcgm_exporter() {
  local node="$1"
  log "Deploying dcgm-exporter to $node"
  if [ "$node" = "localhost" ]; then
    DCGM_EXPORTER_PORT="$DCGM_EXPORTER_PORT" DCGM_EXPORTER_IMAGE="$DCGM_EXPORTER_IMAGE" bash "$REPORT_DIR/scripts/install-dcgm-exporter-remote.sh"
    return
  fi
  ssh $SSH_OPTS "${SSH_USER}@${node}" "DCGM_EXPORTER_PORT='$DCGM_EXPORTER_PORT' DCGM_EXPORTER_IMAGE='$DCGM_EXPORTER_IMAGE' bash -s" < "$REPORT_DIR/scripts/install-dcgm-exporter-remote.sh"
}

deploy() {
  write_generated_scripts
  : > "$REPORT_DIR/deploy-results.txt"

  while IFS= read -r node; do
    [ -n "$node" ] || continue
    if ssh_check "$node"; then
      if deploy_node_exporter "$node"; then
        printf 'node-exporter %s OK\n' "$node" >> "$REPORT_DIR/deploy-results.txt"
      else
        printf 'node-exporter %s FAILED\n' "$node" >> "$REPORT_DIR/deploy-results.txt"
      fi
    else
      printf 'ssh %s FAILED\n' "$node" >> "$REPORT_DIR/deploy-results.txt"
    fi
  done < "$REPORT_DIR/all-nodes.txt"

  while IFS= read -r node; do
    [ -n "$node" ] || continue
    if ssh_check "$node"; then
      if deploy_dcgm_exporter "$node"; then
        printf 'dcgm-exporter %s OK\n' "$node" >> "$REPORT_DIR/deploy-results.txt"
      else
        printf 'dcgm-exporter %s FAILED\n' "$node" >> "$REPORT_DIR/deploy-results.txt"
      fi
    fi
  done < "$REPORT_DIR/gpu-nodes.txt"

  log "Deployment results: $REPORT_DIR/deploy-results.txt"
}

main() {
  normalize_mode
  detect_nodes
  write_plan
  case "$MODE" in
    plan)
      ;;
    generate-scripts)
      write_generated_scripts
      ;;
    deploy)
      deploy
      ;;
  esac
}

main "$@"
