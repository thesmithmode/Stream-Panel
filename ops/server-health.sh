#!/usr/bin/env bash
# Read-only diagnostics: no credentials, database rows, or process arguments in output.
set -euo pipefail
public_host=$(python3 - <<'PY'
from urllib.parse import urlsplit
from pathlib import Path
for line in Path('/etc/stream-panel/server.env').read_text().splitlines():
    if line.startswith('STREAM_PANEL_PUBLIC_ORIGIN='):
        value=line.split('=',1)[1].strip().strip('\"').strip("'")
        print(urlsplit(value).netloc)
        break
PY
)
test -n "$public_host"
date -u +%FT%TZ
uptime
systemctl is-active stream-panel
systemctl show stream-panel -p MainPID -p NRestarts -p MemoryCurrent -p CPUUsageNSec -p TasksCurrent
free -m
df -Pm /var/lib/stream-panel
for path in / /healthz /api/v1/events; do
  for sample in 1 2 3; do
    curl --max-time 10 -fsS -o /dev/null -H "Host: $public_host" -w "$path local status=%{http_code} ttfb=%{time_starttransfer} total=%{time_total}\n" "http://127.0.0.1:47831$path" || test "$path" = /api/v1/events
  done
done
curl --max-time 10 -fsS -H "Host: $public_host" http://127.0.0.1:47831/healthz
printf '\n'
