import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {AnalyticsHistory} from '../src/analytics-history.js';
import {audienceAnalytics} from '../src/analytics.js';
const base=Date.UTC(2026,9,1),minute=60000;
function fixture(s:StreamStore,n=4,youtube=false){for(let i=0;i<n;i++){
 const at=base+i*86400000,sid=s.startSession('owner',String(i),at,'platform',at);
 s.streamSample(sid,at,'game','Game','',10);
 s.recordPoll(sid,'owner',{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:['viewer'],userNames:{viewer:'Viewer'}});
 s.ingest({source:'twitch',accountId:'owner',externalId:String(i),type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at+minute,receivedAtMs:at+minute,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{count:1}});
 if(youtube&&i===0)s.attachPlatformStream(sid,'youtube','yt-owner','video',at,at,null,'Video');
 s.endSession(sid,at+3*minute);
}}
const options={fromMs:base,toMs:base+10*86400000,timezone:'Europe/Moscow',ownerId:'owner',minSessions:2,minMessages:2,minMinutes:1};
function ready(h:AnalyticsHistory,opts:Parameters<AnalyticsHistory['report']>[0]=options){let r:any;for(let i=0;i<100;i++){r=h.report(opts);if(!r.preparing)return r;}throw Error('preparation did not finish');}
test('incremental reports agree with raw facts, clocks and cohorts; late data and renamed identities invalidate cached streams',()=>{
 const s=new StreamStore(':memory:');try{
 fixture(s);s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:base}],true,options.toMs);
 const db=(s as any).db,h=new AnalyticsHistory(db),raw=audienceAnalytics(db,options),r=ready(h);
 assert.deepEqual(r.summary,raw.summary);assert.deepEqual(r.composition,raw.composition);assert.deepEqual(r.streamComparison,raw.streamComparison);assert.deepEqual(r.hours,raw.hours);
 for(const field of ['messages','observedMinutes','estimatedChatMinutes','visits','core','follower','attendanceRatio','donations'])assert.deepEqual(r.audience[0][field],(raw.audience[0] as any)[field]);
 assert.equal(r.timeline.reduce((n:number,p:any)=>n+p.messages,0),raw.summary.messages);assert.ok(r.clockBuckets.some((p:any)=>p.day==='weekends'));assert.ok(r.clockBuckets.some((p:any)=>p.day==='weekdays'));
 const person=r.audience[0].id;s.setPersonMetadata(person,[],false,s.personRevision(person));assert.equal(ready(h).summary.core,0);
 s.ingest({source:'twitch',accountId:'owner',externalId:'late',type:'chat.message',actor:{externalId:'viewer',displayName:'Renamed'},occurredAtMs:base+minute,receivedAtMs:options.toMs,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{count:1}});
 const late=ready(h);assert.equal(late.summary.messages,5);assert.equal(late.audience[0].name,audienceAnalytics(db,options).audience[0]!.name);
 db.prepare('UPDATE analytics_stream_cache SET payload=?').run(Buffer.from('invalid gzip'));assert.equal(ready(new AnalyticsHistory(db)).summary.messages,5);
 assert.throws(()=>h.report({...options,fromMs:-1}),/INVALID_ANALYTICS_FILTER/);assert.throws(()=>h.report({...options,timezone:'no/timezone'}),/INVALID_TIMEZONE/);
 assert.equal(new AnalyticsHistory(db).report({...options,fromMs:base-86400000,toMs:base-1}).summary.streams,0);
 }finally{s.close();}
});
test('more than 200 streams prepare in bounded batches and remain browsable without a range error',()=>{
 const s=new StreamStore(':memory:');try{fixture(s,201);const opts={...options,toMs:base+202*86400000},h=new AnalyticsHistory((s as any).db);assert.equal((s.analytics(opts) as any).preparing,true);
 let status;do{status=s.warmAnalytics(opts);}while(status.preparing);
 let result:any;do{result=s.analytics(opts);}while(result.preparing);assert.equal(result.summary.streams,201);assert.equal(result.summary.messages,201);assert.equal(s.sessions(undefined,100).length,100);assert.equal(s.sessions(undefined,200).length,1);assert.throws(()=>s.sessions(undefined,-1),/INVALID/);assert.equal(ready(h,opts).aggregate,true);
 }finally{s.close();}
});

test('cached money, platform inference and core rules match raw analytics after corrections and identity merges',()=>{
 const s=new StreamStore(':memory:');try{
 fixture(s,2,true);const db=(s as any).db,h=new AnalyticsHistory(db),person=s.analytics(options).audience[0]!.id;
 s.youtubeMessages('yt-owner','chat',[{id:'yt',snippet:{type:'textMessageEvent',publishedAt:new Date(base).toISOString()},authorDetails:{channelId:'yt-viewer',displayName:'YouTube Viewer'}}]);
 const tip=s.createDonation({personId:person,amount:'10',currency:'RUB',occurredAtMs:base+minute,message:'Preserved',sourceName:'Cash'},base+minute);
 s.followingSnapshot('twitch','owner',[],true,base);s.followingSnapshot('youtube','yt-owner',[{id:'yt-viewer',name:'YouTube Viewer',followedAtMs:null}],false,base);
 s.setPersonMetadata(person,['Friend'],null,s.personRevision(person));
 const opts={...options,youtubeAccount:'yt-owner'};
 for(const source of ['all','twitch','youtube'] as const)for(const coreRule of ['either','both','frequency'] as const){const query={...opts,source,coreRule};const raw=audienceAnalytics(db,query),r=ready(h,query);assert.deepEqual(r.summary,raw.summary);assert.deepEqual(r.composition,raw.composition);for(const p of raw.audience){const cached=r.audience.find((q:any)=>q.id===p.id);assert.equal(cached.messages,p.messages);assert.deepEqual(cached.donations,p.donations);assert.deepEqual(cached.tags,p.tags);}}
 s.updateDonation(String(tip.id),{personId:person,amount:'0.50',currency:'USD',occurredAtMs:base+86400000+minute,message:'Corrected',sourceName:'Cash'},0,base+86400000+2*minute);
 assert.deepEqual(ready(h,opts).audience.find((p:any)=>p.id===person).donations,{USD:'50'});
 s.deleteDonation(String(tip.id),1,base+86400000+3*minute);assert.deepEqual(ready(h,opts).audience.find((p:any)=>p.id===person).donations,{});
 const yt=s.persons().find(p=>String(p.sources).includes('youtube'))!.id as string;s.merge(yt,person,s.personRevision(yt),s.personRevision(person),options.toMs);
 assert.equal(ready(h,opts).summary.entities,1);
 assert.deepEqual(ready(h,{...opts,category:'game'}).summary,audienceAnalytics(db,{...opts,category:'game'}).summary);
 // A live stream is evaluated freshly and never persisted as a closed-stream cache.
 const live=s.startSession('owner','live',base+9*86400000,'platform',base+9*86400000);assert.equal(ready(h,opts).summary.streams,3);assert.equal(db.prepare('SELECT count(*) n FROM analytics_stream_cache WHERE session_id=?').get(live).n,0);
 }finally{s.close();}
});

test('derived analytics skip persistence at storage/size bounds and recover without changing facts',()=>{
 const s=new StreamStore(':memory:');try{fixture(s);const db=(s as any).db;
 for(const policy of [{availableBytes:()=>0},{maxBytes:1},{maxTotalBytes:0}]){
  const bounded=new AnalyticsHistory(db,policy);assert.equal(bounded.prepare(options).preparing,false);
  assert.equal(ready(bounded).summary.messages,4);assert.equal(db.prepare('SELECT count(*) n FROM analytics_stream_cache').get().n,0);
 }
 const h=new AnalyticsHistory(db);assert.equal(ready(h).summary.messages,4);
 const prepare=db.prepare.bind(db);let once=true;db.prepare=(sql:string)=>{if(once&&sql.startsWith('SELECT person_id,manual_core')){once=false;throw Error('TRANSIENT_TEST_FAILURE');}return prepare(sql);};
 const failing=new AnalyticsHistory(db);assert.throws(()=>failing.report(options),/TRANSIENT_TEST_FAILURE/);assert.equal(ready(failing).summary.messages,4);db.prepare=prepare;
 assert.equal(s.summary().messages,4);
 }finally{s.close();}
});

test('cached clock/day statistics split midnight and preserve known zero viewers and silent presence',()=>{
 const s=new StreamStore(':memory:');try{
 const at=base+3*86400000+23*3600000+59*minute,id=s.startSession('owner','midnight',at,'platform',at);s.streamSample(id,at,'game','Game','',0);
 s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+minute-1,status:'complete',userIds:['silent']});s.recordPoll(id,'owner',{startedAtMs:at+minute,completedAtMs:at+2*minute,status:'complete',userIds:[]});s.endSession(id,at+2*minute);
 const db=(s as any).db,h=new AnalyticsHistory(db),query={...options,timezone:'UTC',minSessions:1,minMinutes:0,minMessages:0},r=ready(h,query);
 assert.equal(r.timeline.length,2);assert.equal(r.timeline[0].viewers,0);assert.equal(r.timeline[1].observed,0);assert.equal(r.timeline[1].presenceKnown,true);
 assert.ok(r.clockBuckets.some((b:any)=>b.day==='weekends'&&b.minute===23*60+59));assert.ok(r.clockBuckets.some((b:any)=>b.day==='weekdays'&&b.minute===0));assert.equal(r.summary.messages,0);assert.equal(r.summary.attendees,1);
 }finally{s.close();}
});

test('unchanged closed history reuses its report across empty date extensions while offline donations and tags stay current',()=>{
 const s=new StreamStore(':memory:');try{fixture(s,7);const db=(s as any).db,h=new AnalyticsHistory(db),r=ready(h),id=r.audience[0].id;
 db.prepare('DELETE FROM analytics_stream_cache').run();
 const later={...options,toMs:options.toMs+1000};assert.equal(h.report(later).preparing,undefined);assert.equal(h.report(later).summary.messages,7);assert.equal(h.report(later).filters.toMs,later.toMs);
 s.createDonation({personId:id,amount:'1',currency:'RUB',occurredAtMs:options.toMs-1000,message:'Offline',sourceName:'Cash'},options.toMs-1000);assert.deepEqual(h.report(later).donationTiming.totals,{RUB:'100'});
 s.setPersonMetadata(id,['Changed'],true,s.personRevision(id));const changed=ready(h,later);assert.deepEqual(changed.audience[0].tags,['Changed']);assert.equal(changed.summary.core,1);
 }finally{s.close();}
});

test('a completed report refreshes channel reports and excludes them from Twitch-only responses',()=>{
 const s=new StreamStore(':memory:');try{fixture(s);const h=new AnalyticsHistory((s as any).db),query={...options,youtubeAccount:'yt-owner'};
 ready(h,query);s.youtubeSnapshot('yt-owner','report',{start:'2026-10-01',end:'2026-10-02',columnHeaders:[],rows:[[1]]},base);assert.deepEqual(h.report(query).youtubeReport?.data.rows,[[1]]);
 const twitch={...query,source:'twitch' as const};ready(h,twitch);assert.equal(h.report(twitch).youtubeReport,null);
 }finally{s.close();}
});


test('half-hour timezone midnight divides weekday and weekend clock buckets',()=>{
 const s=new StreamStore(':memory:');try{
 const at=Date.UTC(2026,9,2,18,29),id=s.startSession('owner','fractional-midnight',at,'platform',at);
 s.streamSample(id,at,'game','Game','',10);s.endSession(id,at+2*minute);
 const r=ready(new AnalyticsHistory((s as any).db),{...options,timezone:'Asia/Kolkata'});
 const minuteBuckets=r.clockBuckets.filter((b:any)=>b.resolution===1);
 assert.ok(minuteBuckets.some((b:any)=>b.day==='weekdays'&&b.minute===1439));
 assert.ok(minuteBuckets.some((b:any)=>b.day==='weekends'&&b.minute===0));
 assert.ok(!minuteBuckets.some((b:any)=>b.day==='weekdays'&&b.minute===0));
 assert.ok(!minuteBuckets.some((b:any)=>b.day==='weekends'&&b.minute===1439));
 }finally{s.close();}
});

test('a global cache budget evicts deterministically and reports larger than the budget still finish',()=>{
 const s=new StreamStore(':memory:');try{
 fixture(s,12);const db=(s as any).db,seed=new AnalyticsHistory(db),opts={...options,toMs:base+14*86400000};ready(seed,opts);
 const rows=db.prepare('SELECT session_id,cache_key,length(payload) bytes FROM analytics_stream_cache ORDER BY session_id,cache_key').all();
 assert.equal(rows.length,12);const limit=Math.max(...rows.map((r:any)=>r.bytes));
 db.prepare('UPDATE analytics_stream_cache SET updated_at_ms=0').run();
 const bounded=new AnalyticsHistory(db,{maxTotalBytes:limit});
 bounded.prepare(opts);
 assert.ok(db.prepare('SELECT coalesce(sum(length(payload)),0) n FROM analytics_stream_cache').get().n<=limit);
 assert.equal(db.prepare('SELECT session_id FROM analytics_stream_cache').get().session_id,rows.at(-1).session_id);
 const report=ready(bounded,opts);assert.equal(report.summary.messages,12);assert.equal(report.summary.streams,12);
 assert.ok(db.prepare('SELECT coalesce(sum(length(payload)),0) n FROM analytics_stream_cache').get().n<=limit);
 const retained=db.prepare('SELECT session_id,cache_key,updated_at_ms FROM analytics_stream_cache ORDER BY session_id,cache_key').all();
 for(let n=0;n<3;n++)assert.equal(bounded.prepare(opts).preparing,false);
 assert.deepEqual(db.prepare('SELECT session_id,cache_key,updated_at_ms FROM analytics_stream_cache ORDER BY session_id,cache_key').all(),retained,'background warming must not churn a full cache');
 assert.equal(ready(new AnalyticsHistory(db,{maxTotalBytes:limit}),opts).summary.messages,12);
 const person=report.audience[0].id;
 const tip=s.createDonation({personId:person,amount:'2',currency:'RUB',occurredAtMs:base+minute,message:'Late',sourceName:'Cash'},options.toMs);
 const changed=ready(bounded,opts);assert.deepEqual(changed.audience.find((p:any)=>p.id===person).donations,{RUB:'200'});
 s.updateDonation(String(tip.id),{personId:person,amount:'3',currency:'RUB',occurredAtMs:base+minute,message:'Corrected',sourceName:'Cash'},0,options.toMs+minute);
 assert.deepEqual(ready(bounded,opts).audience.find((p:any)=>p.id===person).donations,{RUB:'300'});
 assert.equal(s.summary().messages,12);
 }finally{s.close();}
});

test('independent filters finish when browsers interleave incremental historical report requests',()=>{
 const s=new StreamStore(':memory:');
 try{
  fixture(s,201);
  const h=new AnalyticsHistory((s as any).db),range={...options,toMs:base+202*86400000};
  const queries=[{...range,source:'all' as const},{...range,source:'twitch' as const}];
  const completed=new Map<string,any>();
  for(let attempt=0;attempt<100&&completed.size<queries.length;attempt++){
   for(const query of queries){
    if(completed.has(query.source))continue;
    const result=h.report(query);
    if(!result.preparing)completed.set(query.source,result);
   }
  }
  assert.equal(completed.size,2,'neither browser may reset the other browser progress');
  for(const result of completed.values()){assert.equal(result.summary.streams,201);assert.equal(result.summary.messages,201);}
  // Completed results and a late correction remain independent of other filters.
  s.ingest({source:'twitch',accountId:'owner',externalId:'late-interleaved',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:base+minute,receivedAtMs:range.toMs,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{count:1}});
  assert.equal(ready(h,queries[0]!).summary.messages,202);
 }finally{s.close();}
});

test('expired or displaced report preparation can restart without losing historical facts',t=>{
 const s=new StreamStore(':memory:');let now=options.toMs;
 t.mock.method(Date,'now',()=>now);
 try{
  fixture(s,60);const h=new AnalyticsHistory((s as any).db),query={...options,toMs:base+62*86400000};
  while(h.prepare(query).preparing){/* warm bounded batches */}
  assert.equal(h.report(query).ready,25);assert.equal(h.report(query).ready,50);
  now+=6*60000;
  h.prepare(query); // Scheduled maintenance releases abandoned browser work.
  assert.equal(h.report(query).ready,25);
  assert.equal(ready(h,query).summary.messages,60);
  const first={...query,minMessages:100};
  assert.equal(h.report(first).ready,25);assert.equal(h.report(first).ready,50);
  for(let filter=101;filter<106;filter++)assert.equal(h.report({...query,minMessages:filter}).preparing,true);
  assert.equal(h.report(first).ready,25,'displaced work restarts safely instead of retaining unlimited jobs');
  assert.equal(ready(h,first).summary.messages,60);assert.equal(s.eventCount(),60);
 }finally{s.close();}
});
