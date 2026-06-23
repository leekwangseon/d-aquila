#!/usr/bin/env bash
set -euo pipefail

echo "== d-aquila preflight =="

if command -v squeue >/dev/null 2>&1; then
  echo "Slurm client: OK ($(command -v squeue))"
else
  echo "Slurm client: missing"
fi

if [ -d /etc/slurm ] || [ -d /etc/slurm-llnl ]; then
  echo "Slurm config: OK"
else
  echo "Slurm config: missing"
fi

if [ -S /run/munge/munge.socket.2 ] || [ -S /var/run/munge/munge.socket.2 ]; then
  echo "Munge socket: OK"
else
  echo "Munge socket: missing"
fi

for url in "${D_AQUILA_PROMETHEUS_URL:-http://localhost:9090}" http://localhost:9090 http://127.0.0.1:9090; do
  if curl -fsS "$url/-/ready" >/dev/null 2>&1; then
    echo "Prometheus: OK ($url)"
    exit 0
  fi
done

echo "Prometheus: not detected"
