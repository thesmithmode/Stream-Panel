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
# Report only known startup failures and source locations, never arbitrary log messages.
python3 - <<'PYDIAGNOSTICS'
import json, re, subprocess
result=subprocess.run(['journalctl','-u','stream-panel','--since','-20 minutes','-n','500','--no-pager','-o','cat'],capture_output=True,text=True,timeout=10)
text=result.stdout
codes=sorted(set(re.findall(r'\b(?:SQLITE_(?:ERROR|BUSY|LOCKED|CONSTRAINT|FULL|CORRUPT|NOTADB|READONLY)|ERR_(?:WORKER_OUT_OF_MEMORY|MODULE_NOT_FOUND|DLLOPEN_FAILED|INVALID_ARG_TYPE)|DB_WORKER_STOPPED)\b',text)))
schema=sorted(set(re.findall(r'(?:no such (?:table|column)|already exists):? [a-z_][a-z0-9_.]{0,80}',text)))
frames=sorted(set(re.findall(r'(?:dist|node_modules)/[a-zA-Z0-9_./-]+\.(?:js|mjs|cjs):[0-9]+(?::[0-9]+)?',text)))
print('startup_diagnostics='+json.dumps({'codes':codes,'schema':schema,'frames':frames[-20:],'heapLimitReached':'heap out of memory' in text.lower(),'oomKilled':'oom-kill' in text.lower()}))
PYDIAGNOSTICS
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
# Inspect the dedicated volatile cache without exposing cached values.
if systemctl is-active --quiet stream-panel-cache; then
  printf 'redis service=active ping='
  timeout 5 redis-cli -h 127.0.0.1 -p 6380 ping
  timeout 5 redis-cli -h 127.0.0.1 -p 6380 INFO memory | tr -d '\r' | sed -n '/^used_memory:/p;/^maxmemory:/p;/^maxmemory_policy:/p'
  timeout 5 redis-cli -h 127.0.0.1 -p 6380 INFO stats | tr -d '\r' | sed -n '/^keyspace_hits:/p;/^keyspace_misses:/p;/^evicted_keys:/p'
  timeout 5 redis-cli -h 127.0.0.1 -p 6380 CONFIG GET bind
  timeout 5 redis-cli -h 127.0.0.1 -p 6380 CONFIG GET appendonly
  timeout 5 redis-cli -h 127.0.0.1 -p 6380 CONFIG GET save
else
  echo 'Redis service is unavailable'; exit 1
fi
# Only metadata is printed; never output secrets, objects or database contents.
python3 - <<'PYCLOUD'
import json, time, re, hashlib
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
config={}
for line in Path('/etc/stream-panel/server.env').read_text().splitlines():
    if '=' in line:
        key,value=line.split('=',1)
        config[key]=value.strip().strip('"').strip("'")
for profile in ('ruslan','gulnaz'):
    path=Path(config.get('STREAM_PANEL_DATA_DIR','/var/lib/stream-panel'))/'profiles'/profile/'secrets.json'
    if path.exists():
        token=json.loads(path.read_text()).get('twitch')
        print('twitch profile='+profile+' connected='+str(bool(token)).lower()+' followers_scope='+str(bool(token and 'moderator:read:followers' in token.get('scopes',[]))).lower())
url=config.get('STREAM_PANEL_SUPABASE_URL','')
keyfile=config.get('STREAM_PANEL_SUPABASE_KEY_FILE','')
if not url or not keyfile:
    raise SystemExit('Cloud backups are not configured')
parsed=urlsplit(url)
if parsed.scheme!='https' or not (parsed.hostname or '').endswith('.supabase.co') or parsed.path not in ('','/'):
    raise SystemExit('Invalid backup endpoint')
key=Path(keyfile).read_text().strip()
bucket='stream-panel-backups'
ledger=json.loads((Path(config.get('STREAM_PANEL_DATA_DIR','/var/lib/stream-panel'))/'backup-state.json').read_text())
prefix='stream-panel/'+ledger['installationId']
def call(path,body=None):
    request=Request(url.rstrip('/')+'/storage/v1/'+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+key,'apikey':key,'Content-Type':'application/json'})
    with urlopen(request,timeout=30) as response:
        raw=response.read(4*1024*1024+1)
        if len(raw)>4*1024*1024: raise ValueError('Oversized metadata')
        return json.loads(raw)
try:
    info=call('bucket/'+bucket)
    if info.get('public') is not False: raise ValueError('Backup bucket must be private')
    objects=call('object/list/'+bucket,{'prefix':prefix,'limit':1000,'offset':0,'sortBy':{'column':'name','order':'desc'}})
    valid=re.compile(r'^stream-panel-[\dTZ-]+-[a-f0-9]{8}\.spbk$')
    copies={row['name'].removesuffix('.manifest.json'):row for row in objects if valid.fullmatch(row.get('name','').removesuffix('.manifest.json'))}
    local=Path(config.get('STREAM_PANEL_DATA_DIR','/var/lib/stream-panel'))/'backups'
    matching=sorted((p for p in local.glob('stream-panel-*.spbk') if p.name in copies),key=lambda p:p.name,reverse=True)
    if not matching: raise ValueError('No matching local and cloud backup')
    latest=matching[0]; remote=copies[latest.name]
    digest=hashlib.sha256()
    with latest.open('rb') as source:
        while chunk:=source.read(1024*1024): digest.update(chunk)
    local_hash=digest.hexdigest()
    if remote['name'].endswith('.manifest.json'):
        manifest=call('object/authenticated/'+bucket+'/'+prefix+'/'+remote['name'])
        if manifest.get('filename')!=latest.name or manifest.get('size')!=latest.stat().st_size or manifest.get('sha256')!=local_hash:
            raise ValueError('Cloud manifest does not match local archive')
        verification='manifest_sha256'
    else:
        request=Request(url.rstrip('/')+'/storage/v1/object/authenticated/'+bucket+'/'+prefix+'/'+latest.name,headers={'Authorization':'Bearer '+key,'apikey':key})
        digest=hashlib.sha256(); size=0
        with urlopen(request,timeout=30) as response:
            while chunk:=response.read(1024*1024):
                size+=len(chunk)
                if size>latest.stat().st_size: raise ValueError('Cloud archive too large')
                digest.update(chunk)
        if size!=latest.stat().st_size or digest.hexdigest()!=local_hash: raise ValueError('Cloud archive content mismatch')
        verification='download_sha256'
    print('cloud verification='+verification+' content_match=true')
    age=max(0,int(time.time()-latest.stat().st_mtime))
    print('cloud bucket_private=true copies='+str(len(copies))+' matching_local=true age_seconds='+str(age))
    print('cloud latest='+latest.name+' uploaded_at='+str(remote.get('updated_at')))
    if age>13*3600: raise ValueError('Cloud backup is stale')
except Exception as error:
    # Error bodies can contain credentials; report only known local checks.
    print('Cloud verification failed ('+type(error).__name__+')')
    raise SystemExit(1)
PYCLOUD
