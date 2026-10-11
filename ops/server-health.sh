#!/usr/bin/env bash
# Read-only diagnostics: no credentials, database rows, or process arguments in output.
set -euo pipefail
mapfile -t endpoint < <(python3 - <<'PYCONFIG'
from urllib.parse import urlsplit
from pathlib import Path
config={}
for line in Path('/etc/stream-panel/server.env').read_text().splitlines():
    if '=' in line:
        key,value=line.split('=',1)
        config[key]=value.strip().strip('"').strip("'")
print(urlsplit(config['STREAM_PANEL_PUBLIC_ORIGIN']).netloc)
bind=config.get('STREAM_PANEL_BIND_HOST','127.0.0.1')
bind={'0.0.0.0':'127.0.0.1','::':'::1'}.get(bind,bind)
if ':' in bind:bind=f'[{bind}]'
print(f"http://{bind}:{int(config.get('STREAM_PANEL_PORT','47831'))}")
PYCONFIG
)
public_host=${endpoint[0]}
local_origin=${endpoint[1]}
test -n "$public_host"
date -u +%FT%TZ
uptime
systemctl is-active stream-panel
systemctl show stream-panel -p MainPID -p NRestarts -p MemoryCurrent -p CPUUsageNSec -p TasksCurrent
free -m
df -Pm /var/lib/stream-panel
for path in / /healthz /api/v1/events; do
  for sample in 1 2 3; do
    result=$(curl --max-time 10 -sS -o /dev/null -H "Host: $public_host" -w '%{http_code} %{time_starttransfer} %{time_total}' "$local_origin$path")
    read -r code first_byte total <<< "$result"
    printf '%s local status=%s ttfb=%s total=%s\n' "$path" "$code" "$first_byte" "$total"
    expected=200;test "$path" != /api/v1/events || expected=401
    test "$code" = "$expected"
  done
done
curl --max-time 10 -fsS -H "Host: $public_host" "$local_origin/healthz"
printf '\n'
