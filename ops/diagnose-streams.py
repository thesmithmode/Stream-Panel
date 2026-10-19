"""Read-only incident diagnostics. Output counts and times only, never identities or secrets."""
import json, sqlite3, subprocess
from pathlib import Path
config={}
for line in Path('/etc/stream-panel/server.env').read_text().splitlines():
    if '=' in line:
        key,value=line.split('=',1);config[key]=value.strip().strip('"').strip("'")
path=Path(config.get('STREAM_PANEL_DATA_DIR','/var/lib/stream-panel'))/'data.sqlite'
db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)
db.row_factory=sqlite3.Row
db.execute('PRAGMA query_only=ON')
print('integrity='+str(db.execute('PRAGMA quick_check').fetchone()[0]))
print('foreign_key_errors='+str(len(db.execute('PRAGMA foreign_key_check').fetchall())))
for profile in ('ruslan','gulnaz'):
    p='p_'+profile+'_'
    rows=db.execute(f'''SELECT s.id,s.started_at_ms,s.ended_at_ms,
    (SELECT count(*) FROM {p}stream_samples x WHERE x.session_id=s.id) AS samples,
    (SELECT count(*) FROM {p}stream_samples x WHERE x.session_id=s.id AND x.twitch_viewers IS NOT NULL) AS twitch_samples,
    (SELECT count(*) FROM {p}stream_samples x WHERE x.session_id=s.id AND x.youtube_viewers IS NOT NULL) AS youtube_samples,
    (SELECT count(*) FROM {p}presence_polls x WHERE x.session_id=s.id) AS polls
    FROM {p}sessions s ORDER BY started_at_ms DESC LIMIT 3''').fetchall()
    print(json.dumps({'profile':profile,'recent':[{k:r[k] for k in r.keys() if k!='id'} for r in rows]}))
    for row in rows[:1]:
        print('sample_ranges='+json.dumps([dict(r) for r in db.execute(f'SELECT min(observed_at_ms) AS first,max(observed_at_ms) AS last,max(twitch_viewers) AS twitch_peak,max(youtube_viewers) AS youtube_peak FROM {p}stream_samples WHERE session_id=?',(row['id'],))]))
        print('platforms='+json.dumps([dict(r) for r in db.execute(f'SELECT platform,started_at_ms,ended_at_ms,last_observed_at_ms FROM {p}platform_streams WHERE session_id=?',(row['id'],))]))
    print('schema='+json.dumps([dict(r) for r in db.execute('SELECT profile,version FROM sp_profile_schema WHERE profile=?',(profile,))]))
db.close()
# Extract only known errors, rather than printing arbitrary provider/user payloads.
import re
logs=subprocess.run(['journalctl','-u','stream-panel','--since','-12 hours','-n','20000','--no-pager','-o','cat'],capture_output=True,text=True,timeout=20).stdout
patterns=['SQLITE_[A-Z_]+','INVALID_STREAM_SAMPLE','INVALID_YOUTUBE_SESSION','UNKNOWN_OPERATION','STORAGE_FULL','DB_WORKER_[A-Z_]+','no such (?:table|column): [a-zA-Z0-9_.]+','[A-Za-z_]+ has [0-9]+ columns but [0-9]+ values were supplied','(?:dist|node_modules)/[a-zA-Z0-9_./-]+\\.(?:js|mjs|cjs):[0-9]+(?::[0-9]+)?']
print('errors='+json.dumps({p:sorted(set(re.findall(p,logs))) for p in patterns}))
print('release='+Path('/opt/stream-panel/current').resolve().name)
# Verify the deployed calculation against real samples, using a read-only handle.
node_program=r'''
import Database from 'better-sqlite3';
import {streamMetrics} from './dist/packages/core/src/stream-metrics.js';
import {windowsFromLinks} from './dist/packages/core/src/session-windows.js';
const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});
try{
 for(const profile of ['ruslan','gulnaz']){
  const p='p_'+profile+'_',s=db.prepare(`SELECT id,started_at_ms,ended_at_ms FROM ${p}sessions ORDER BY started_at_ms DESC LIMIT 1`).get();
  if(!s)continue;
  const links=db.prepare(`SELECT platform,started_at_ms AS "from",coalesce(ended_at_ms,?) AS "to" FROM ${p}platform_streams WHERE session_id=?`).all(Date.now(),s.id);
  const samples=db.prepare(`SELECT observed_at_ms,twitch_viewers,youtube_viewers FROM ${p}stream_samples WHERE session_id=? ORDER BY observed_at_ms`).all(s.id);
  const windows=windowsFromLinks(links.map(l=>({started_at_ms:l.from,ended_at_ms:l.to})),s.started_at_ms,s.ended_at_ms??Date.now());
  const metrics=streamMetrics(windows,samples,new Map(),links).viewers;
  console.log('deployed_viewers='+JSON.stringify({profile,known:metrics.known??null,twitch:metrics.twitch,youtube:metrics.youtube}));
 }
}finally{db.close();}
'''
subprocess.run(['/opt/stream-panel/current/bin/node','--input-type=module','-e',node_program,str(path)],cwd='/opt/stream-panel/current',check=True,timeout=30)

# Credential presence and Google access-token health only; no secrets leave the host.
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError
for profile in ('ruslan','gulnaz'):
    secret_path=Path(config.get('STREAM_PANEL_DATA_DIR','/var/lib/stream-panel'))/'profiles'/profile/'secrets.json'
    saved=json.loads(secret_path.read_text()) if secret_path.exists() else {}
    token=saved.get('youtube') or {}
    result={'profile':profile,'clientId':bool(saved.get('youtubeClientId')),'clientSecret':bool(saved.get('youtubeClientSecret')),'access':bool(token.get('access')),'refresh':bool(token.get('refresh')),'expired':token.get('expiresAt',0)<time.time()*1000}
    if token.get('access'):
        try:
            with urlopen(Request('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true',headers={'Authorization':'Bearer '+token['access']}),timeout=15) as response:
                result['googleStatus']=response.status
        except HTTPError as error:
            result['googleStatus']=error.code
            try:
                payload=json.loads(error.read())
                result['reasons']=[e.get('reason') for e in payload.get('error',{}).get('errors',[]) if e.get('reason') in ('authError','quotaExceeded','dailyLimitExceeded','insufficientPermissions','accessNotConfigured')]
            except Exception: pass
        except Exception: result['googleStatus']='network_error'
    print('youtube_auth='+json.dumps(result))
