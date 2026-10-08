#!/bin/bash
# Run once after read-only inventory, on a host with free HTTP/HTTPS ports.
set -euo pipefail
umask 077
[[ $EUID == 0 && $# == 3 ]] || { echo 'Usage (root): bootstrap.sh PUBLIC_IPV4 DEPLOY_PUBLIC_KEY_FILE VERIFIED_CADDY_BINARY'; exit 1; }
public_ip=$1; key_file=$2; caddy_binary=$3
python3 - "$public_ip" <<'PY'
import ipaddress,sys
ip=ipaddress.ip_address(sys.argv[1])
if ip.version != 4 or not ip.is_global: raise SystemExit('Public IPv4 required')
PY
ops_dir=$(cd "$(dirname "$0")" && pwd)
"$ops_dir/preflight.sh"
[[ $(getconf GNU_LIBC_VERSION | cut -d' ' -f2) == 2.* ]] || exit 1
python3 - <<'PY'
import os
version=tuple(map(int,os.confstr('CS_GNU_LIBC_VERSION').split()[1].split('.')))
if version < (2,35): raise SystemExit('Bundle requires glibc >=2.35 (Ubuntu 22.04+/Debian 12+)')
PY
[[ -x $caddy_binary && -r $key_file ]] || exit 1
[[ ! -e /opt/stream-panel && ! -e /etc/stream-panel && ! -e /var/lib/stream-panel && ! -e /etc/systemd/system/stream-panel.service && ! -e /etc/sudoers.d/stream-panel ]] || { echo 'Existing installation found; refusing to overwrite. Use release receiver for upgrades.'; exit 1; }
for user in stream-panel stream-panel-proxy stream-panel-deploy; do
  if id "$user" &>/dev/null; then echo "Existing account $user; refusing to reuse"; exit 1; fi
done
ssh-keygen -l -f "$key_file" >/dev/null
[[ $(wc -l < "$key_file") -eq 1 && $(cut -d' ' -f1 "$key_file") == ssh-ed25519 ]] || { echo 'One plain Ed25519 public key required'; exit 1; }
useradd --system --user-group --home-dir /var/lib/stream-panel --shell /usr/sbin/nologin stream-panel
useradd --system --user-group --home-dir /var/lib/stream-panel-proxy --shell /usr/sbin/nologin stream-panel-proxy
useradd --system --user-group --home-dir /var/lib/stream-panel-deploy --shell /bin/sh stream-panel-deploy
install -d -m 755 /opt/stream-panel/releases /opt/stream-panel/proxy
install -d -m 750 -o root -g stream-panel /etc/stream-panel
install -d -m 700 -o stream-panel -g stream-panel /var/lib/stream-panel
install -d -m 700 -o stream-panel-proxy -g stream-panel-proxy /var/lib/stream-panel-proxy
install -d -m 700 -o root -g root /var/lib/stream-panel-deploy
install -m 755 "$caddy_binary" /opt/stream-panel/proxy/caddy
install -m 755 "$ops_dir/receive.py" /usr/local/sbin/stream-panel-receive
origin="https://stream-panel.${public_ip//./-}.sslip.io"
printf '%s\n' "$origin" > /etc/stream-panel/public-origin
cat > /etc/stream-panel/server.env <<ENV
STREAM_PANEL_DATA_DIR=/var/lib/stream-panel
STREAM_PANEL_PUBLIC_ORIGIN=$origin
STREAM_PANEL_PORT=47831
STREAM_PANEL_BACKUP_KEY_FILE=/etc/stream-panel/backup-key
ENV
python3 - <<'PY' > /etc/stream-panel/backup-key
import secrets
print(secrets.token_hex(32))
PY
chown root:stream-panel /etc/stream-panel/server.env /etc/stream-panel/backup-key
chmod 640 /etc/stream-panel/server.env /etc/stream-panel/backup-key
# Proxy has its own state and config, no access to application secrets.
cat > /etc/stream-panel/Caddyfile <<CADDY
{
  admin off
}
${origin#https://} {
  reverse_proxy 127.0.0.1:47831
  header Strict-Transport-Security "max-age=31536000"
  log {
    output discard
  }
}
CADDY
chown root:stream-panel-proxy /etc/stream-panel/Caddyfile
chmod 640 /etc/stream-panel/Caddyfile
# Directory traversal to proxy config is allowed, reading secret files is not.
chmod 755 /etc/stream-panel
install -d -m 700 -o root -g root /var/lib/stream-panel-deploy/.ssh
printf 'restrict,command="/usr/bin/sudo -n /usr/local/sbin/stream-panel-receive" %s\n' "$(cat "$key_file")" > /var/lib/stream-panel-deploy/.ssh/authorized_keys
chmod 644 /var/lib/stream-panel-deploy/.ssh/authorized_keys
# sshd can read root-owned keys; deploy account cannot change its forced command.
chmod 755 /var/lib/stream-panel-deploy /var/lib/stream-panel-deploy/.ssh
printf 'stream-panel-deploy ALL=(root) NOPASSWD: /usr/local/sbin/stream-panel-receive ""\n' > /etc/sudoers.d/stream-panel
chmod 440 /etc/sudoers.d/stream-panel
visudo -cf /etc/sudoers.d/stream-panel >/dev/null
install -m 644 "$ops_dir/stream-panel.service" "$ops_dir/stream-panel-proxy.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable stream-panel.service stream-panel-proxy.service
systemctl start stream-panel-proxy.service
printf 'Bootstrap complete: %s. Deploy release, provision accounts; validate HTTPS before use.\n' "$origin"
