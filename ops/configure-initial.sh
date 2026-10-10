#!/bin/bash
# Trusted current-main payload, executed by bootstrap.yml through root SSH.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || exit 1
system_root=${STREAM_PANEL_CONFIGURE_ROOT:-}
config_dir=${STREAM_PANEL_CONFIG_DIR:-${system_root}/etc/stream-panel}
data_dir=${STREAM_PANEL_DATA_DIR:-${system_root}/var/lib/stream-panel}
current_dir=${STREAM_PANEL_CURRENT_DIR:-${system_root}/opt/stream-panel/current}
lock_file=${STREAM_PANEL_LOCK_FILE:-${system_root}/run/lock/stream-panel-configure.lock}
receive_cmd=${STREAM_PANEL_RECEIVE:-${system_root}/usr/local/sbin/stream-panel-receive}
installed_receiver=${STREAM_PANEL_INSTALLED_RECEIVER:-/usr/local/sbin/stream-panel-receive}
bootstrap_cmd=${STREAM_PANEL_BOOTSTRAP_TRAEFIK:-$PWD/bootstrap-traefik.sh}
systemctl_cmd=${STREAM_PANEL_SYSTEMCTL:-systemctl}
runuser_cmd=${STREAM_PANEL_RUNUSER:-${system_root}/usr/sbin/runuser}
mapfile -t network < network
[[ ${#network[@]} == 3 ]] || exit 1

# Validate the optional pair before locks, services, files, or other server state change.
cloud_url_present=0; cloud_key_present=0
[[ -s supabase-url ]] && cloud_url_present=1
[[ -s supabase-key ]] && cloud_key_present=1
if [[ $cloud_url_present != "$cloud_key_present" ]]; then
  echo 'Supabase URL and key must be provided together' >&2
  exit 1
fi
python3 - "$cloud_url_present" <<'PY'
import json,pathlib,re,sys,urllib.parse
users=json.loads(pathlib.Path('accounts.json').read_text())
assert isinstance(users,list) and len(users)==2 and {u['profile'] for u in users}=={'ruslan','gulnaz'}
assert all(isinstance(u.get('password'),str) and 14<=len(u['password'])<=256 for u in users)
assert all(re.fullmatch('[a-z][a-z0-9_.-]{2,31}',u['username']) and isinstance(u.get('displayName'),str) and u['displayName'].strip() and len(u['displayName'])<=100 for u in users)
assert len({u['username'].lower() for u in users})==2
if sys.argv[1]=='1':
 url=pathlib.Path('supabase-url').read_text().strip(); parsed=urllib.parse.urlparse(url)
 assert parsed.scheme=='https' and parsed.hostname and parsed.hostname.endswith('.supabase.co') and url=='https://'+parsed.hostname
 assert 1<=len(pathlib.Path('supabase-key').read_text().strip())<=8192
PY
exec 8>>"$lock_file"
flock -n 8 || { echo 'Another configuration operation is active'; exit 1; }
if [[ -e $config_dir/bootstrap-identity.json ]]; then
  # Resume only our installation, with exactly the original network and keys.
  python3 - "${network[@]}" "$config_dir/bootstrap-identity.json" <<'PY'
import hashlib,json,pathlib,stat,sys
marker=pathlib.Path(sys.argv[4]); info=marker.lstat()
assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600
expected=dict(version=1,public=sys.argv[1],bridge=sys.argv[2],proxy=sys.argv[3],deploy_key=hashlib.sha256(pathlib.Path('deploy.pub').read_bytes()).hexdigest(),backup_key=hashlib.sha256(pathlib.Path('backup-key').read_bytes()).hexdigest())
assert json.loads(marker.read_text())==expected, 'Existing installation identity differs'
PY
else
  bash "$bootstrap_cmd" "${network[0]}" deploy.pub backup-key "${network[1]}" "${network[2]}"
fi
# Resume may find an installation marker written before an interrupted bootstrap
# installed the current receiver. Refresh it only after identity validation.
python3 - "$installed_receiver" <<'PY'
import os,pathlib,stat,sys
target=pathlib.Path(sys.argv[1])
parent=target.parent
info=parent.lstat()
assert stat.S_ISDIR(info.st_mode) and info.st_uid==0, 'Receiver directory must be a root-owned real directory'
assert parent.resolve(strict=True)==parent.absolute(), 'Receiver directory path must not traverse symlinks'
try: current=target.lstat()
except FileNotFoundError: pass
else: assert stat.S_ISREG(current.st_mode) and current.st_uid==0, 'Existing receiver must be a root-owned regular file'
source=pathlib.Path('receive.py'); source_info=source.lstat()
assert stat.S_ISREG(source_info.st_mode), 'Trusted receiver payload must be a regular file'
PY
install -m 755 -o root -g root receive.py "$installed_receiver"
if [[ $cloud_url_present == 1 ]]; then
  install -m 640 -o root -g stream-panel supabase-key "$config_dir/supabase-key"
fi
# Rewrite the owned cloud settings; local-only bootstrap removes stale cloud configuration.
python3 - "$config_dir/server.env" "$cloud_url_present" <<'PY'
import pathlib,sys
path=pathlib.Path(sys.argv[1])
lines=[line for line in path.read_text().splitlines() if not line.startswith(('STREAM_PANEL_SUPABASE_URL=','STREAM_PANEL_SUPABASE_KEY_FILE='))]
if sys.argv[2]=='1':
 lines+=['STREAM_PANEL_SUPABASE_URL='+pathlib.Path('supabase-url').read_text().strip(),'STREAM_PANEL_SUPABASE_KEY_FILE='+str(path.parent/'supabase-key')]
path.write_text('\n'.join(lines)+'\n')
PY
if [[ $cloud_url_present == 0 ]]; then rm -f -- "$config_dir/supabase-key"; fi
install -m 600 /dev/null "$data_dir/initializing"
cat server.header server.tar.gz | "$receive_cmd"
payload_dir=$PWD
# Avoid concurrent startup and provisioning backups using the same snapshot file.
"$systemctl_cmd" stop stream-panel.service
trap '"$systemctl_cmd" start stream-panel.service' EXIT
cd "$current_dir"
"$runuser_cmd" -u stream-panel -- env STREAM_PANEL_DATA_DIR="$data_dir" ./bin/node scripts/provision-accounts.mjs --resume < "$payload_dir/accounts.json"
set -a
source "$config_dir/server.env"
set +a
"$runuser_cmd" -u stream-panel -- ./bin/node --input-type=module -e 'import {BackupService} from "./dist/apps/daemon/src/backup.js";const configured=Boolean(process.env.STREAM_PANEL_SUPABASE_URL&&process.env.STREAM_PANEL_SUPABASE_KEY_FILE);const backup=new BackupService(process.env.STREAM_PANEL_DATA_DIR,{keyFile:process.env.STREAM_PANEL_BACKUP_KEY_FILE,...(configured?{url:process.env.STREAM_PANEL_SUPABASE_URL,serviceKeyFile:process.env.STREAM_PANEL_SUPABASE_KEY_FILE}:{})});const result=await backup.run();if(result.cloudError)throw new Error("INITIAL_CLOUD_BACKUP_FAILED");if(configured?backup.status.cloud.state!=="success":backup.status.state!=="local"||backup.status.cloud.state!=="disabled")throw new Error("INITIAL_BACKUP_STATE_INVALID");const files=await backup.files();if(!files.files.some(file=>file.filename===result.filename))throw new Error("INITIAL_LOCAL_BACKUP_MISSING");if(!(await backup.file(result.filename)).subarray(0,5).equals(Buffer.from("SPBK1")))throw new Error("INITIAL_LOCAL_BACKUP_INVALID");console.log(configured?"Provisioned local and cloud backups verified":"Provisioned encrypted local backup verified");'
rm -f -- "$data_dir/initializing"
