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
if db.execute("SELECT 1 FROM sqlite_master WHERE name='sp_auth_sessions'").fetchone():
    print('panel_sessions='+json.dumps([dict(r) for r in db.execute('SELECT profile,count(*) sessions,min(expires_at_ms) first_expiry,max(expires_at_ms) last_expiry FROM sp_auth_sessions GROUP BY profile')]))
runtime=subprocess.run(['systemctl','show','stream-panel','-p','NRestarts','-p','ActiveEnterTimestamp','-p','ExecMainStartTimestamp','-p','Result'],capture_output=True,text=True,timeout=10)
print('runtime='+json.dumps(runtime.stdout.splitlines()))
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
print('runtime_events='+json.dumps({'serverReady':logs.count('Stream Panel server listening'),'heapLimitReached':'heap out of memory' in logs.lower(),'oomKilled':'oom-kill' in logs.lower()}))
print('release='+Path('/opt/stream-panel/current').resolve().name)
# Verify the deployed calculation against real samples, using a read-only handle.
node_program=r'''
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {profileView} from './dist/packages/core/src/profile-db.js';
import {logicalReadDatabase} from './dist/packages/core/src/session-groups.js';
import {audienceAnalytics} from './dist/packages/core/src/analytics.js';
import {registerDonationSum} from './dist/packages/core/src/donation-statistics.js';
import {streamMetrics} from './dist/packages/core/src/stream-metrics.js';
import {windowsFromLinks} from './dist/packages/core/src/session-windows.js';
const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});
db.pragma('query_only=ON');
db.pragma('busy_timeout=5000');
registerDonationSum(db);
const reportCounts=report=>({participants:report.audience.length,
 observedParticipants:report.audience.filter(p=>p.observedMinutes>0).length,
 observedMinutes:report.audience.reduce((n,p)=>n+p.observedMinutes,0),
 estimatedMinutes:report.audience.reduce((n,p)=>n+p.estimatedChatMinutes,0),
 messages:report.audience.reduce((n,p)=>n+p.messages,0)});
try{
 for(const profile of ['ruslan','gulnaz']){
  const p='p_'+profile+'_',s=db.prepare(`SELECT id,started_at_ms,ended_at_ms FROM ${p}sessions ORDER BY started_at_ms DESC LIMIT 1`).get();
  if(!s)continue;
  const links=db.prepare(`SELECT platform,started_at_ms AS "from",coalesce(ended_at_ms,?) AS "to" FROM ${p}platform_streams WHERE session_id=?`).all(Date.now(),s.id);
  const samples=db.prepare(`SELECT observed_at_ms,twitch_viewers,youtube_viewers FROM ${p}stream_samples WHERE session_id=? ORDER BY observed_at_ms`).all(s.id);
  const windows=windowsFromLinks(links.map(l=>({started_at_ms:l.from,ended_at_ms:l.to})),s.started_at_ms,s.ended_at_ms??Date.now());
  const metrics=streamMetrics(windows,samples,new Map(),links).viewers;
  console.log('deployed_viewers='+JSON.stringify({profile,known:metrics.known??null,twitch:metrics.twitch,youtube:metrics.youtube}));
  const scoped=logicalReadDatabase(profileView(db,profile));
  const cfg=JSON.parse(readFileSync(join(dirname(process.argv[1]),'profiles',profile,'secrets.json'),'utf8'));
  const recent=scoped.prepare('SELECT id,started_at_ms,ended_at_ms FROM sessions ORDER BY started_at_ms DESC LIMIT 3').all();
  for(const session of recent){
   const id=session.id,start=session.started_at_ms,end=session.ended_at_ms??Date.now();
   const polls=scoped.prepare(`SELECT p.status,count(*) polls,
    sum((SELECT count(*) FROM presence_members m WHERE m.poll_id=p.id)) memberships,
    sum(NOT EXISTS(SELECT 1 FROM presence_members m WHERE m.poll_id=p.id)) emptyPolls
    FROM presence_polls p WHERE session_id=? GROUP BY p.status`).all(id);
   const people=scoped.prepare(`SELECT count(DISTINCT i.id) identities,count(DISTINCT i.person_id) people,
    count(DISTINCT CASE WHEN i.external_id=i.account_id THEN i.person_id END) owners
    FROM presence_polls p JOIN presence_members m ON m.poll_id=p.id JOIN identities i ON i.id=m.identity_id
    WHERE p.session_id=? AND p.status='complete'`).get(id);
   const events=scoped.prepare(`SELECT e.type,count(*) count FROM effective_events e
    JOIN event_sessions es ON es.event_id=e.id WHERE es.session_id=? GROUP BY e.type`).all(id);
   const youtube=scoped.prepare(`SELECT count(*) messages,count(DISTINCT author_id) authors
    FROM youtube_messages WHERE published_at_ms>=? AND published_at_ms<?`).get(start,end);
   const gaps=scoped.prepare(`SELECT source,reason,count(*) count FROM collection_gaps
    WHERE started_at_ms<? AND coalesce(ended_at_ms,?)>=? GROUP BY source,reason`).all(end,end,start)
    .map(r=>({...r,reason:/^[a-zA-Z0-9_]{1,80}$/.test(r.reason)?r.reason:'other'}));
   console.log('participant_inputs='+JSON.stringify({profile,start,end,polls,people,events,youtube,gaps}));
   try{
    const report=audienceAnalytics(scoped,{fromMs:start,toMs:end,sessionId:id,source:'all',category:'',timezone:'Europe/Moscow',
     excludedLogins:cfg.excludedBotLogins??[],ownerId:cfg.twitch?.userId??'',youtubeAccount:cfg.youtube?.userId??cfg.youtubeAccountId??''});
    console.log('participant_calculation='+JSON.stringify({profile,start,...reportCounts(report)}));
   }catch(error){console.log('participant_calculation='+JSON.stringify({profile,start,error:/^[A-Z_]{1,80}$/.test(error.message)?error.message:'CALCULATION_FAILED'}));}
   for(const table of ['analytics_stream_facts','analytics_stream_cache']){
    const cached=scoped.prepare(`SELECT payload,updated_at_ms,revision FROM ${table} WHERE session_id=? ORDER BY updated_at_ms DESC LIMIT 5`).all(id);
    console.log('participant_cache='+JSON.stringify({profile,start,table,entries:cached.map(row=>{
     try{const report=JSON.parse(gunzipSync(row.payload,{maxOutputLength:16*1024*1024}));return {at:row.updated_at_ms,revision:row.revision,from:report.filters.fromMs,to:report.filters.toMs,source:report.filters.source,categoryFiltered:Boolean(report.filters.category),...reportCounts(report)};}
     catch{return {at:row.updated_at_ms,invalid:true};}
    })}));
   }
  }
 }
}finally{db.close();}
'''
subprocess.run(['/opt/stream-panel/current/bin/node','--input-type=module','-e',node_program,str(path)],cwd='/opt/stream-panel/current',check=True,timeout=30)

# Credential presence and Google access-token health only; no secrets leave the host.
import time
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from urllib.error import HTTPError
for profile in ('ruslan','gulnaz'):
    secret_path=Path(config.get('STREAM_PANEL_DATA_DIR','/var/lib/stream-panel'))/'profiles'/profile/'secrets.json'
    saved=json.loads(secret_path.read_text()) if secret_path.exists() else {}
    twitch=saved.get('twitch') or {}
    twitch_result={'profile':profile,'tokenPresent':bool(twitch.get('access'))}
    if twitch.get('access'):
        for label,url in [('validate','https://id.twitch.tv/oauth2/validate'),('chatters','https://api.twitch.tv/helix/chat/chatters?'+urlencode({'broadcaster_id':twitch.get('userId',''),'moderator_id':twitch.get('userId',''),'first':1000}))]:
            try:
                headers={'Authorization':('OAuth ' if label=='validate' else 'Bearer ')+twitch['access'],'Client-Id':saved.get('twitchClientId','')}
                with urlopen(Request(url,headers=headers),timeout=15) as response:
                    payload=json.loads(response.read())
                    twitch_result[label+'Status']=response.status
                    if label=='validate':
                        twitch_result['sameAccount']=payload.get('user_id')==twitch.get('userId')
                        twitch_result['numericAccount']=str(payload.get('user_id','')).isdigit()
                        if profile=='ruslan': twitch_result['currentLoginMatches']=payload.get('login')=='rlod'
                        twitch_result['chattersScope']='moderator:read:chatters' in payload.get('scopes',[])
                    else:
                        twitch_result['dataArray']=isinstance(payload.get('data'),list)
                        twitch_result['chattersNow']=len(payload.get('data',[]))
                        twitch_result['reportedTotal']=payload.get('total')
                        twitch_result['hasNextPage']=bool(payload.get('pagination',{}).get('cursor'))
            except HTTPError as error: twitch_result[label+'Status']=error.code
            except Exception: twitch_result[label+'Status']='network_error'
    if twitch.get('access'):
        try:
            url='https://api.twitch.tv/helix/chat/chatters?'+urlencode({'broadcaster_id':twitch.get('userId',''),'moderator_id':twitch.get('userId',''),'first':100})
            with urlopen(Request(url,headers={'Authorization':'Bearer '+twitch['access'],'Client-Id':saved.get('twitchClientId','')}),timeout=15) as response:
                payload=json.loads(response.read())
                twitch_result['alternateStatus']=response.status
                twitch_result['alternateCount']=len(payload.get('data',[]))
                twitch_result['alternateTotal']=payload.get('total')
        except HTTPError as error: twitch_result['alternateStatus']=error.code
        except Exception: twitch_result['alternateStatus']='network_error'
    print('twitch_auth='+json.dumps(twitch_result))
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
    # Bounded, read-only evidence for the current channel's subscriber graph.
    account=token.get('userId') or saved.get('youtubeAccountId') or ''
    table='p_'+profile+'_subscriber_counts'
    with sqlite3.connect(path.as_uri()+'?mode=ro',uri=True) as history_db:
        history_db.execute('PRAGMA query_only=ON')
        if history_db.execute('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?',(table,)).fetchone():
            count,first,last=history_db.execute(f"SELECT count(*),min(observed_at_ms),max(observed_at_ms) FROM {table} WHERE source='youtube' AND account_id=?",(account,)).fetchone()
            latest=history_db.execute(f"SELECT total FROM {table} WHERE source='youtube' AND account_id=? ORDER BY observed_at_ms DESC LIMIT 1",(account,)).fetchone()
            print('youtube_subscribers='+json.dumps({'profile':profile,'configured':bool(account),'samples':count,'first':first,'last':last,'total':latest[0] if latest else None}))
