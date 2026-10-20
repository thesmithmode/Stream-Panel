import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {StreamStore} from '../src/store.js';
import {logicalReadDatabase} from '../src/session-groups.js';
import {followingAnalytics,personFollowing} from '../src/following.js';
import {audienceAnalytics} from '../src/analytics.js';
import {AnalyticsHistory} from '../src/analytics-history.js';
import {latestFollowerChecksSql,latestFollowerSnapshotsSql,streamFollowerObservationsSql} from '../src/follower-queries.js';

// The previous queries are an independent equivalence oracle, not a second production path.
const legacyStream=`SELECT source,account_id AS account,observed_at_ms AS at,payload_json FROM follower_observations p WHERE key='followers' AND ((observed_at_ms>=? AND observed_at_ms<=?) OR id=(SELECT q.id FROM follower_observations q WHERE q.source=p.source AND q.account_id=p.account_id AND q.key='followers' ORDER BY q.observed_at_ms DESC,q.id DESC LIMIT 1)) ORDER BY observed_at_ms`;
const legacyLatest=`SELECT p.source,p.account_id,p.payload_json FROM follower_observations p WHERE key='followers' AND id=(SELECT q.id FROM follower_observations q WHERE q.source=p.source AND q.account_id=p.account_id AND q.key='followers' ORDER BY observed_at_ms DESC,id DESC LIMIT 1)`;
const legacyDate=`SELECT json_extract(f.value,'$.followedAtMs') AS at FROM follower_observations p,json_each(p.payload_json,'$.followers') f WHERE p.source=? AND p.account_id=? AND p.key='followers' AND json_extract(f.value,'$.id')=? AND json_type(f.value,'$.followedAtMs')='integer' ORDER BY p.observed_at_ms DESC,p.id DESC LIMIT 1`;
const legacyStreamDates=`SELECT json_extract(f.value,'$.followedAtMs') AS at FROM follower_observations p,json_each(p.payload_json,'$.followers') f WHERE p.source=? AND p.account_id=? AND p.key='followers' AND json_extract(f.value,'$.id')=? AND json_extract(f.value,'$.followedAtMs') BETWEEN ? AND ?`;
const legacyChanges=`WITH states AS (
 SELECT p.id,p.observed_at_ms AS at,CASE WHEN f.value IS NOT NULL THEN 1 WHEN p.source='twitch' AND json_extract(p.payload_json,'$.complete')=1 THEN 0 ELSE NULL END AS status,json_extract(f.value,'$.followedAtMs') AS followedAtMs
 FROM follower_observations p LEFT JOIN json_each(p.payload_json,'$.followers') f ON json_extract(f.value,'$.id')=? WHERE p.source=? AND p.account_id=? AND p.key='followers'
), compared AS (SELECT *,row_number() OVER(ORDER BY at,id) AS position,lag(status) OVER(ORDER BY at,id) AS priorStatus,lag(followedAtMs) OVER(ORDER BY at,id) AS priorDate FROM states)
SELECT at,status,followedAtMs FROM compared WHERE position=1 OR status IS NOT priorStatus OR followedAtMs IS NOT priorDate ORDER BY at,id`;
function legacyReader(db:Database.Database):Database.Database{
 return new Proxy(db,{get(target,key){
  if(key==='prepare')return(sql:string)=>target.prepare(sql===streamFollowerObservationsSql?legacyStream:sql===latestFollowerSnapshotsSql?legacyLatest:sql.startsWith('WITH dates AS MATERIALIZED')?(sql.includes("d.date_type='integer'")?legacyDate:legacyStreamDates):sql.startsWith('WITH snapshots AS MATERIALIZED')?legacyChanges:sql);
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
}
const base=Date.UTC(2026,9,1),m=60000;
function fixture(s:StreamStore,count=1660){
 const session=s.startSession('owner','query-equivalence',base,'platform',base);
 s.streamSample(session,base,'game','Game','',2);
 const person=s.ingest({source:'twitch',accountId:'owner',externalId:'chat',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:base,receivedAtMs:base,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{count:1}}).personId!;
 s.recordPoll(session,'owner',{startedAtMs:base,completedAtMs:base+m,status:'complete',userIds:['viewer']});
 const db=(s as any).db as Database.Database;
 db.transaction(()=>{
  for(let n=0;n<count;n++)s.followingSnapshot('twitch','owner',n%3===0?[]:[{id:'viewer',name:'Viewer',followedAtMs:base+(n%3)*m},{id:'unlinked',name:'Other',followedAtMs:base+3*m}],n%3!==1,base+n*m,n%3);
  s.followingSnapshot('youtube','owner',[{id:'viewer',name:'Public',followedAtMs:null}],false,base+5*m,100);
  s.followingSnapshot('youtube','owner',[{id:'viewer',name:'Public',followedAtMs:base+2*m}],false,base+20*m,101);
  s.followingSnapshot('twitch','other',[],true,base+4*m,9);
 })();
 s.endSession(session,base+10*m);
 return {db,session,person};
}
test('optimized follower queries match the previous complete results with 1660 checks and repeated payloads',()=>{
 const s=new StreamStore(':memory:');try{
  const {db,session,person}=fixture(s),reads=logicalReadDatabase(db),legacy=legacyReader(reads),count=(sql:string)=>(db.prepare(sql).get() as {n:number}).n;
  const checks=count('SELECT count(*) n FROM follower_checks'),snapshots=count('SELECT count(*) n FROM provider_snapshots');
  assert.ok(snapshots<checks/100);
  assert.deepEqual(followingAnalytics(reads,session),followingAnalytics(legacy,session));
  assert.deepEqual(personFollowing(reads,person,session),personFollowing(legacy,person,session));
  assert.deepEqual(personFollowing(reads,person),personFollowing(legacy,person));
  const query={fromMs:base,toMs:base+10*m,ownerId:'owner',youtubeAccount:'owner',timezone:'Europe/Moscow'};
  assert.deepEqual(audienceAnalytics(reads,query),audienceAnalytics(legacy,query));
  const h=new AnalyticsHistory(reads);try{let r;do{r=h.report(query);}while(r.preparing);assert.deepEqual(r.summary,audienceAnalytics(legacy,query).summary);assert.deepEqual(r.composition,audienceAnalytics(legacy,query).composition);}finally{h.close();}
  assert.equal(count('SELECT count(*) n FROM follower_checks'),checks);assert.equal(count('SELECT count(*) n FROM provider_snapshots'),snapshots);assert.deepEqual(db.pragma('foreign_key_check'),[]);
 }finally{s.close();}
});
test('latest follower lookup orders by actual checks, retains tie breaks, and ignores unchecked or unrelated snapshots',()=>{
 const s=new StreamStore(':memory:');try{
  const {db,session,person}=fixture(s,5);
  db.prepare("INSERT INTO provider_snapshots VALUES ('orphan-shape','twitch','owner','followers',?,NULL,?)").run(base+100*m,JSON.stringify({followers:['not-a-follower'],complete:true,total:1}));
  const reads=logicalReadDatabase(db);assert.deepEqual(personFollowing(reads,person,session),personFollowing(legacyReader(reads),person,session),'unchecked payloads are not observation history');
  const payload=JSON.stringify({followers:[],complete:true,total:7});
  db.prepare("INSERT INTO provider_snapshots VALUES ('unchecked','twitch','unchecked','followers',?,NULL,?)").run(base+100*m,payload);
  db.prepare("INSERT INTO provider_snapshots VALUES ('pending','donationalerts','owner','donation_unparsed',?,NULL,'{}')").run(base+100*m);
  db.prepare("INSERT INTO follower_checks VALUES ('pending-check','pending',?,NULL)").run(base+101*m);
  const versions=db.prepare("SELECT id FROM provider_snapshots WHERE source='twitch' AND account_id='owner' AND id<>'orphan-shape' ORDER BY id").all() as {id:string}[];
  db.prepare('INSERT INTO follower_checks VALUES (?,?,?,NULL)').run('aaa',versions[0]!.id,base+200*m);
  db.prepare('INSERT INTO follower_checks VALUES (?,?,?,NULL)').run('zzz',versions[1]!.id,base+200*m);
  const latest=db.prepare(latestFollowerChecksSql).all() as {source:string;account_id:string;snapshot_id:string;id:string}[];
  assert.equal(latest.find(p=>p.source==='twitch'&&p.account_id==='owner')!.id,'zzz');
  assert.ok(latest.every(p=>p.source!=='donationalerts'&&p.account_id!=='unchecked'));
  const order=(rows:unknown[])=>rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(order(db.prepare(latestFollowerSnapshotsSql).all()),order(db.prepare(legacyLatest).all()));
 }finally{s.close();}
});
test('optimized reads preserve linked-stream gaps and independent profile histories',()=>{
 const s=new StreamStore(':memory:');try{
  const {db,session,person}=fixture(s,20),next=s.startSession('owner','second-part',base+30*m,'platform',base+30*m);
  s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:base+25*m},{id:'second',name:'Second',followedAtMs:base+31*m}],true,base+32*m,10);
  s.endSession(next,base+35*m);s.mergeSessions([session,next]);
  const reads=logicalReadDatabase(db),legacy=legacyReader(reads);
  assert.deepEqual(followingAnalytics(reads,session),followingAnalytics(legacy,session));assert.deepEqual(personFollowing(reads,person,session),personFollowing(legacy,person,session));
  assert.ok(followingAnalytics(reads,session).newFollowers.every(f=>f.at!==base+25*m),'the gap between linked streams is not airtime');
 }finally{s.close();}
 // Identical account IDs coexist in one file; every archive lookup stays scoped.
 const dir=mkdtempSync(join(tmpdir(),'sp-follower-scope-')),path=join(dir,'data.sqlite');
 const stores=[new StreamStore(path,'ruslan'),new StreamStore(path,'gulnaz')];
 try{
  const totals=stores.map((store,index)=>{const {db,session}=fixture(store,5+index),reads=logicalReadDatabase(db);assert.deepEqual(followingAnalytics(reads,session),followingAnalytics(legacyReader(reads),session));return (db.prepare(latestFollowerSnapshotsSql).all() as {source:string;account_id:string;payload_json:string}[]).find(p=>p.source==='twitch'&&p.account_id==='owner')!.payload_json;});
  assert.deepEqual(totals.map(value=>JSON.parse(value).total),[1,2]);
 }finally{for(const store of stores)store.close();rmSync(dir,{recursive:true,force:true});}
});
test('person history remains identical with out-of-order checks, timestamp ties and repeated follow dates',()=>{
 for(let seed=1;seed<=12;seed++){
  const s=new StreamStore(':memory:');try{
   const session=s.startSession('owner','unordered-'+seed,base,'platform',base);
   const person=s.ingest({source:'twitch',accountId:'owner',externalId:'chat',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:base,receivedAtMs:base,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{count:1}}).personId!;
   for(let n=0;n<40;n++)s.followingSnapshot('twitch','owner',n%3?[{id:'viewer',name:'Viewer',followedAtMs:base+((seed*n)%12)*m}]:[],n%4!==0,base+((n*17+seed)%11)*m,n%7);
   s.ingest({source:'twitch',accountId:'owner',externalId:'late-follow',type:'follow',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:base+2*m,receivedAtMs:base+20*m,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{}});
   s.endSession(session,base+8*m);
   const reads=logicalReadDatabase((s as any).db),legacy=legacyReader(reads);
   assert.deepEqual(personFollowing(reads,person,session),personFollowing(legacy,person,session));assert.deepEqual(personFollowing(reads,person),personFollowing(legacy,person));
  }finally{s.close();}
 }
});
