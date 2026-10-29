#!/bin/bash
# Installs the on-server liveness watchdog; recovery never depends on GitHub.
# Usage (root): install-watchdog.sh <path-to-stream-watchdog.py>
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Root required'; exit 1; }
source=${1:?watchdog script required}
python3 -c 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_bytes(), "watchdog", "exec")' "$source"
install -o root -g root -m 755 "$source" /usr/local/sbin/stream-panel-watchdog
install -d -o root -g root -m 700 /var/lib/stream-panel-watchdog
cat > /etc/systemd/system/stream-panel-watchdog.service <<'SERVICE'
[Unit]
Description=Stream Panel liveness check (5 min live, 6 h otherwise)
After=stream-panel.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/sbin/stream-panel-watchdog
TimeoutStartSec=120
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
SERVICE
cat > /etc/systemd/system/stream-panel-watchdog.timer <<'TIMER'
[Unit]
Description=Run Stream Panel liveness check every 5 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
AccuracySec=15s
[Install]
WantedBy=timers.target
TIMER
systemctl daemon-reload
systemctl enable --now stream-panel-watchdog.timer
systemctl is-active --quiet stream-panel-watchdog.timer
echo 'Stream Panel watchdog timer active'
