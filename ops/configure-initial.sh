#!/bin/bash
# Trusted current-main payload, executed by bootstrap.yml through root SSH.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || exit 1
mapfile -t network < network
[[ ${#network[@]} == 3 ]] || exit 1
exec 8>>/run/lock/stream-panel-configure.lock
flock -n 8 || { echo 'Another configuration operation is active'; exit 1; }
python3 - <<'PY'
import json,pathlib,re,urllib.parse
users=json.loads(pathlib.Path('accounts.json').read_text())
assert isinstance(users,list) and len(users)==2 and {u['profile'] for u in users}=={'ruslan','gulnaz'}
assert all(isinstance(u.get('password'),str) and 14<=len(u['password'])<=256 for u in users)
assert all(re.fullmatch('[a-z][a-z0-9_.-]{2,31}',u['username']) and isinstance(u.get('displayName'),str) and u['displayName'].strip() and len(u['displayName'])<=100 for u in users)
assert len({u['username'].lower() for u in users})==2
url=pathlib.Path('supabase-url').read_text(); parsed=urllib.parse.urlparse(url)
assert parsed.scheme=='https' and parsed.hostname and parsed.hostname.endswith('.supabase.co') and url=='https://'+parsed.hostname
assert 1<=len(pathlib.Path('supabase-key').read_text().strip())<=8192
PY
if [[ -e /etc/stream-panel/bootstrap-identity.json ]]; then
  # Resume only our installation, with exactly the original network and keys.
  python3 - "${network[@]}" <<'PY'
import hashlib,json,os,pathlib,stat,sys
marker=pathlib.Path('/etc/stream-panel/bootstrap-identity.json')
info=marker.lstat()
assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600
expected=dict(version=1,public=sys.argv[1],bridge=sys.argv[2],proxy=sys.argv[3],deploy_key=hashlib.sha256(pathlib.Path('deploy.pub').read_bytes()).hexdigest(),backup_key=hashlib.sha256(pathlib.Path('backup-key').read_bytes()).hexdigest())
assert json.loads(marker.read_text())==expected, 'Existing installation identity differs'
PY
else
  bash bootstrap-traefik.sh "${network[0]}" deploy.pub backup-key "${network[1]}" "${network[2]}"
fi
install -m 640 -o root -g stream-panel supabase-key /etc/stream-panel/supabase-key
# Rewrite only the two cloud settings in the owned environment file.
python3 - <<'PY'
import pathlib
path=pathlib.Path('/etc/stream-panel/server.env')
lines=[line for line in path.read_text().splitlines() if not line.startswith(('STREAM_PANEL_SUPABASE_URL=','STREAM_PANEL_SUPABASE_KEY_FILE='))]
lines+=['STREAM_PANEL_SUPABASE_URL='+pathlib.Path('supabase-url').read_text(),'STREAM_PANEL_SUPABASE_KEY_FILE=/etc/stream-panel/supabase-key']
path.write_text('\n'.join(lines)+'\n')
PY
cat server.header server.tar.gz | /usr/local/sbin/stream-panel-receive
payload_dir=$PWD
# Avoid concurrent startup and provisioning backups using the same snapshot file.
systemctl stop stream-panel.service
trap 'systemctl start stream-panel.service' EXIT
cd /opt/stream-panel/current
/usr/sbin/runuser -u stream-panel -- env STREAM_PANEL_DATA_DIR=/var/lib/stream-panel ./bin/node scripts/provision-accounts.mjs --resume < "$payload_dir/accounts.json"
# Validate an encrypted local + private cloud copy immediately after provisioning.
set -a
source /etc/stream-panel/server.env
set +a
/usr/sbin/runuser -u stream-panel -- ./bin/node --input-type=module -e 'import {BackupService} from "./dist/apps/daemon/src/backup.js";const backup=new BackupService(process.env.STREAM_PANEL_DATA_DIR,{keyFile:process.env.STREAM_PANEL_BACKUP_KEY_FILE,url:process.env.STREAM_PANEL_SUPABASE_URL,serviceKeyFile:process.env.STREAM_PANEL_SUPABASE_KEY_FILE});await backup.run();console.log("Provisioned data backup verified");'
