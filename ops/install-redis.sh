#!/bin/bash
# Dedicated volatile cache. Bind loopback only; never replace a pre-existing service.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Root required'; exit 1; }
if ! command -v redis-server >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends redis-server
fi
if ! id stream-panel-cache &>/dev/null; then useradd --system --user-group --no-create-home --shell /usr/sbin/nologin stream-panel-cache; fi
install -d -m 755 /etc/stream-panel
cat > /etc/stream-panel/cache.conf <<'CONFIG'
bind 127.0.0.1
port 6380
protected-mode yes
save ""
appendonly no
maxmemory 128mb
maxmemory-policy allkeys-lru
logfile ""
CONFIG
chmod 644 /etc/stream-panel/cache.conf
cat > /etc/systemd/system/stream-panel-cache.service <<'SERVICE'
[Unit]
Description=Stream Panel derived data cache
After=network.target
[Service]
User=stream-panel-cache
Group=stream-panel-cache
ExecStart=/usr/bin/redis-server /etc/stream-panel/cache.conf
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
MemoryMax=192M
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now stream-panel-cache.service
redis-cli -h 127.0.0.1 -p 6380 ping | grep -qx PONG
# Receiver restarts the application after immutable release activation.
if ! grep -q '^STREAM_PANEL_REDIS_URL=' /etc/stream-panel/server.env; then
  printf '\nSTREAM_PANEL_REDIS_URL=redis://127.0.0.1:6380\n' >> /etc/stream-panel/server.env
fi
