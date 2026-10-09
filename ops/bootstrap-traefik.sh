#!/bin/bash
# Invoked only by the main GitHub Actions bootstrap workflow.
set -euo pipefail
umask 077
[[ $EUID == 0 && $# == 5 ]] || { echo 'Expected public IPv4, deploy public key, backup key, bridge address, proxy address'; exit 1; }
public_ip=$1; key_file=$2; backup_key_file=$3; bridge_ip=$4; proxy_ip=$5
ops_dir=$(cd "$(dirname "$0")" && pwd)
exec 9>>/run/lock/stream-panel-bootstrap.lock
flock -n 9 || { echo 'Another Stream Panel bootstrap is running'; exit 1; }

# Read-only input and host checks. Do not create service objects before these pass.
python3 - "$public_ip" "$bridge_ip" "$proxy_ip" "$backup_key_file" <<'PY'
import ipaddress,pathlib,re,sys
public,bridge,proxy=map(ipaddress.ip_address,sys.argv[1:4])
private=[ipaddress.ip_network(n) for n in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')]
if public.version!=4 or not public.is_global: raise SystemExit('Public IPv4 required')
if any(ip.version!=4 or not any(ip in net for net in private) for ip in (bridge,proxy)): raise SystemExit('Private bridge/proxy addresses required')
if bridge==proxy: raise SystemExit('Bridge and proxy must differ')
if not re.fullmatch('[a-f0-9]{64}',pathlib.Path(sys.argv[4]).read_text().strip()): raise SystemExit('Invalid external backup key')
PY
[[ $(uname -m) == x86_64 ]] || exit 1
command -v systemctl >/dev/null
command -v docker >/dev/null
command -v visudo >/dev/null
command -v flock >/dev/null
command -v ss >/dev/null
command -v ip >/dev/null
command -v useradd >/dev/null
command -v userdel >/dev/null
command -v groupdel >/dev/null
command -v getent >/dev/null
python3 - <<'PY'
import os,shutil,tarfile
available=int(next(x.split()[1] for x in open('/proc/meminfo') if x.startswith('MemAvailable:')))
if available < 640*1024: raise SystemExit('Need >=640 MiB currently available memory')
if tuple(map(int,os.confstr('CS_GNU_LIBC_VERSION').split()[1].split('.'))) < (2,35): raise SystemExit('glibc >=2.35 required')
if shutil.disk_usage('/opt').free < 3*2**30: raise SystemExit('Need 3 GiB free')
if not hasattr(tarfile,'data_filter'): raise SystemExit('Python tar security update required')
PY
if ss -H -ltn 'sport = :47831' | grep -q .; then
  echo 'Application port 47831 is occupied'; exit 1
fi
if ! ip -4 -o address show | awk -v ip="$bridge_ip" 'split($4,a,"/") && a[1]==ip { found=1 } END { exit !found }'; then
  echo 'Bridge address is not assigned to this host'; exit 1
fi
# Confirm the observed Traefik topology, without altering its container/network.
docker inspect telegram-cleaner-traefik | python3 -c 'import json,re,sys; c=json.load(sys.stdin)[0]; network=c["NetworkSettings"]["Networks"]["traefik-proxy"]; args=c["Args"]; mount=any(m["Source"]=="/root/traefik/config" and m["Destination"]=="/config" for m in c["Mounts"]); websecure=any(a.lower().startswith("--entrypoints.websecure.address=") and a.split("=",1)[1].split("/",1)[0].rsplit(":",1)[-1]=="443" for a in args); assert c["State"]["Running"] and network["IPAddress"]==sys.argv[1] and network["Gateway"]==sys.argv[2] and mount and "--providers.file.directory=/config" in args and "--providers.file.watch=true" in args and websecure and any(a.lower().startswith("--certificatesresolvers.letsencrypt.") for a in args), "Traefik topology changed"' "$proxy_ip" "$bridge_ip"

route_dir=/root/traefik/config
route=$route_dir/stream-panel.yml
[[ -d $route_dir && ! -L $route_dir && ! -e $route && ! -L $route ]] || { echo 'Route destination unavailable'; exit 1; }
for path in /opt/stream-panel /etc/stream-panel /var/lib/stream-panel /var/lib/stream-panel-deploy /etc/systemd/system/stream-panel.service /etc/systemd/system/stream-panel.service.d /etc/systemd/system/multi-user.target.wants/stream-panel.service /etc/sudoers.d/stream-panel /usr/local/sbin/stream-panel-receive; do
  [[ ! -e $path && ! -L $path ]] || { echo 'Existing installation; refusing overwrite'; exit 1; }
done
for account in stream-panel stream-panel-deploy; do
  ! id "$account" &>/dev/null || { echo 'Existing service account'; exit 1; }
  ! getent group "$account" >/dev/null || { echo 'Existing service group'; exit 1; }
done
ssh-keygen -l -f "$key_file" >/dev/null
[[ $(wc -l < "$key_file") -eq 1 && $(cut -d' ' -f1 "$key_file") == ssh-ed25519 ]] || exit 1

# Prepare the route in its destination filesystem; ln publishes it exclusively.
route_tmp=$(mktemp "$route_dir/.stream-panel.XXXXXX")
route_created=0
app_user_created=0
deploy_user_created=0
opt_root_created=0
releases_created=0
etc_config_created=0
app_data_created=0
deploy_home_created=0
deploy_ssh_created=0
receiver_created=0
origin_created=0
bind_host_created=0
server_env_created=0
backup_key_created=0
authorized_keys_created=0
sudoers_created=0
service_file_created=0
service_enabled=0
bootstrap_complete=0
identity_created=0

rollback() {
  local status=$?
  trap - EXIT
  set +e
  if [[ $bootstrap_complete -ne 1 ]]; then
    if [[ $route_created -eq 1 && -e $route_tmp && $route -ef $route_tmp ]]; then rm -f -- "$route"; fi
    if [[ $service_enabled -eq 1 ]]; then systemctl disable stream-panel.service >/dev/null 2>&1; fi
    if [[ $service_file_created -eq 1 ]]; then rm -f -- /etc/systemd/system/stream-panel.service; systemctl daemon-reload >/dev/null 2>&1; fi
    if [[ $sudoers_created -eq 1 ]]; then rm -f -- /etc/sudoers.d/stream-panel; fi
    if [[ $authorized_keys_created -eq 1 ]]; then rm -f -- /var/lib/stream-panel-deploy/.ssh/authorized_keys; fi
    if [[ $backup_key_created -eq 1 ]]; then rm -f -- /etc/stream-panel/backup-key; fi
    if [[ $identity_created -eq 1 ]]; then rm -f -- /etc/stream-panel/bootstrap-identity.json; fi
    if [[ $server_env_created -eq 1 ]]; then rm -f -- /etc/stream-panel/server.env; fi
    if [[ $bind_host_created -eq 1 ]]; then rm -f -- /etc/stream-panel/bind-host; fi
    if [[ $origin_created -eq 1 ]]; then rm -f -- /etc/stream-panel/public-origin; fi
    if [[ $receiver_created -eq 1 ]]; then rm -f -- /usr/local/sbin/stream-panel-receive; fi
    if [[ $deploy_ssh_created -eq 1 ]]; then rmdir -- /var/lib/stream-panel-deploy/.ssh 2>/dev/null; fi
    if [[ $deploy_home_created -eq 1 ]]; then rmdir -- /var/lib/stream-panel-deploy 2>/dev/null; fi
    if [[ $app_data_created -eq 1 ]]; then rmdir -- /var/lib/stream-panel 2>/dev/null; fi
    if [[ $etc_config_created -eq 1 ]]; then rmdir -- /etc/stream-panel 2>/dev/null; fi
    if [[ $releases_created -eq 1 ]]; then rmdir -- /opt/stream-panel/releases 2>/dev/null; fi
    if [[ $opt_root_created -eq 1 ]]; then rmdir -- /opt/stream-panel 2>/dev/null; fi
    if [[ $deploy_user_created -eq 1 ]]; then userdel stream-panel-deploy >/dev/null 2>&1; groupdel stream-panel-deploy >/dev/null 2>&1; fi
    if [[ $app_user_created -eq 1 ]]; then userdel stream-panel >/dev/null 2>&1; groupdel stream-panel >/dev/null 2>&1; fi
  fi
  if [[ -n ${route_tmp:-} ]]; then rm -f -- "$route_tmp"; fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Create only objects proven absent above; flags let rollback remove only our own objects.
mkdir -m 755 /opt/stream-panel; opt_root_created=1
install -d -m 755 /opt/stream-panel/releases; releases_created=1
useradd --system --user-group --home-dir /var/lib/stream-panel --shell /usr/sbin/nologin stream-panel
app_user_created=1
install -d -m 750 -o root -g stream-panel /etc/stream-panel; etc_config_created=1
install -d -m 700 -o stream-panel -g stream-panel /var/lib/stream-panel; app_data_created=1
useradd --system --user-group --home-dir /var/lib/stream-panel-deploy --shell /bin/sh stream-panel-deploy
deploy_user_created=1
install -d -m 755 -o root -g root /var/lib/stream-panel-deploy; deploy_home_created=1
install -d -m 755 -o root -g root /var/lib/stream-panel-deploy/.ssh; deploy_ssh_created=1
receiver_created=1; install -m 755 "$ops_dir/receive.py" /usr/local/sbin/stream-panel-receive
origin="https://stream-panel.${public_ip//./-}.sslip.io"
origin_created=1; printf '%s\n' "$origin" > /etc/stream-panel/public-origin
bind_host_created=1; printf '%s' "$bridge_ip" > /etc/stream-panel/bind-host
server_env_created=1; cat > /etc/stream-panel/server.env <<ENV
STREAM_PANEL_DATA_DIR=/var/lib/stream-panel
STREAM_PANEL_PUBLIC_ORIGIN=$origin
STREAM_PANEL_PORT=47831
STREAM_PANEL_BIND_HOST=$bridge_ip
STREAM_PANEL_TRUSTED_PROXY=$proxy_ip
STREAM_PANEL_BACKUP_KEY_FILE=/etc/stream-panel/backup-key
ENV
backup_key_created=1; install -m 640 -o root -g stream-panel "$backup_key_file" /etc/stream-panel/backup-key
chown root:stream-panel /etc/stream-panel/server.env
chmod 640 /etc/stream-panel/server.env
authorized_keys_created=1; printf 'restrict,command="/usr/bin/sudo -n /usr/local/sbin/stream-panel-receive" %s\n' "$(cat "$key_file")" > /var/lib/stream-panel-deploy/.ssh/authorized_keys
chmod 644 /var/lib/stream-panel-deploy/.ssh/authorized_keys
sudoers_created=1; printf 'stream-panel-deploy ALL=(root) NOPASSWD: /usr/local/sbin/stream-panel-receive ""\n' > /etc/sudoers.d/stream-panel
chmod 440 /etc/sudoers.d/stream-panel
visudo -cf /etc/sudoers.d/stream-panel >/dev/null
service_file_created=1; install -m 644 "$ops_dir/stream-panel.service" /etc/systemd/system/stream-panel.service
systemctl daemon-reload
systemctl enable stream-panel.service
service_enabled=1

cat > "$route_tmp" <<ROUTE
http:
  routers:
    stream-panel:
      rule: "Host(\`${origin#https://}\`)"
      entryPoints: [websecure]
      service: stream-panel
      middlewares: [stream-panel-security]
      tls:
        certResolver: letsencrypt
  services:
    stream-panel:
      loadBalancer:
        servers:
          - url: "http://$bridge_ip:47831"
  middlewares:
    stream-panel-security:
      headers:
        stsSeconds: 31536000
ROUTE
chmod 644 "$route_tmp"
ln -- "$route_tmp" "$route"
route_created=1
identity_created=1
python3 - "$public_ip" "$bridge_ip" "$proxy_ip" "$key_file" "$backup_key_file" <<'PY'
import hashlib,json,pathlib,sys
identity=dict(version=1,public=sys.argv[1],bridge=sys.argv[2],proxy=sys.argv[3],deploy_key=hashlib.sha256(pathlib.Path(sys.argv[4]).read_bytes()).hexdigest(),backup_key=hashlib.sha256(pathlib.Path(sys.argv[5]).read_bytes()).hexdigest())
with pathlib.Path('/etc/stream-panel/bootstrap-identity.json').open('x') as file: json.dump(identity,file)
PY
bootstrap_complete=1
printf 'Bootstrap ready: %s\n' "$origin"
