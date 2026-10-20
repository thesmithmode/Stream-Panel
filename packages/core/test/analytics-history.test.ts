import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {AnalyticsHistory} from '../src/analytics-history.js';
import {AnalyticsWorkspace} from '../src/analytics-workspace.js';
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
test('idle category baking prepares actual category reports and never rebuilds them on a later clock tick',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,3);const h=(s as any).history as AnalyticsHistory;let progress;do{progress=s.warmAnalytics(options,true);}while(progress.preparing);
  (h as any).aggregate=()=>{throw Error('category was not baked');};(h as any).build=()=>{throw Error('unchanged stream was rebuilt');};
  const report=s.analytics({...options,fromMs:0,source:'all',category:'game',summaryOnly:true,includeInsights:true});assert.equal(report.summary.messages,3);assert.equal(report.preparing,undefined);
  assert.equal(s.warmAnalytics({...options,toMs:options.toMs+60000},true).preparing,false);
 }finally{s.close();}
});
test('renaming a participant rebuilds only their streams and keeps unrelated baked slices',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,1);const at=base+86400000,id=s.startSession('owner','other',at,'platform',at);s.streamSample(id,at,'game','Game','',3);s.endSession(id,at+minute);
  const h=(s as any).history as AnalyticsHistory,first=ready(h),person=first.audience[0].id,db=(s as any).db;
  const global=db.prepare('SELECT revision FROM analytics_global_revision').get().revision;
  const rows=db.prepare('SELECT session_id,revision FROM analytics_stream_cache ORDER BY session_id').all();s.renamePerson(person,'Changed');
  assert.equal(db.prepare('SELECT revision FROM analytics_global_revision').get().revision,global);
  const build=(h as any).build.bind(h),built:string[]=[];(h as any).build=(opts:any,session:any)=>{built.push(session.id);return build(opts,session);};
  const report=ready(h);assert.equal(report.audience[0].name,'Changed');assert.equal(built.length,1);assert.notEqual(built[0],id);
  assert.ok(db.prepare('SELECT 1 FROM analytics_stream_cache WHERE session_id=? AND revision=?').get(id,rows.find((r:any)=>r.session_id===id).revision));
 }finally{s.close();}
});
test('incremental reports agree with raw facts, clocks and cohorts; late data and renamed identities invalidate cached streams',()=>{
 const s=new StreamStore(':memory:');try{
 fixture(s);s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:base}],true,options.toMs);
 const db=(s as any).db,h=new AnalyticsHistory(db),raw=audienceAnalytics(db,options),r=ready(h);
 assert.deepEqual(r.summary,raw.summary);assert.deepEqual(r.composition,raw.composition);assert.deepEqual(r.streamComparison,raw.streamComparison);assert.deepEqual(r.hours,raw.hours);
 const clockSort=(rows:any[])=>[...rows].sort((a,b)=>a.day.localeCompare(b.day)||a.minute-b.minute);assert.deepEqual(clockSort(r.activityClock),clockSort(raw.activityClock));
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
 const failing=new AnalyticsHistory(db,{maxReportBytes:0});assert.throws(()=>failing.report(options),/TRANSIENT_TEST_FAILURE/);assert.equal(ready(failing).summary.messages,4);db.prepare=prepare;
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
  let cpu=0;t.mock.method(performance,'now',()=>cpu+=5);
  const firstProgress=h.report(query),nextProgress=h.report(query);assert.equal(firstProgress.preparing,true);assert.ok(nextProgress.ready!>firstProgress.ready!);
  now+=6*60000;
  h.prepare(query);
  const restarted=h.report(query);assert.equal(restarted.preparing,true);assert.ok(restarted.ready!<nextProgress.ready!);
  assert.equal(ready(h,query).summary.messages,60);
  const first={...query,minMessages:100};
  const initial=h.report(first),progress=h.report(first);assert.ok(progress.ready!>initial.ready!);
  for(let filter=101;filter<106;filter++)assert.equal(h.report({...query,minMessages:filter}).preparing,true);
  assert.ok(h.report(first).ready!<progress.ready!,'displaced work restarts safely instead of retaining unlimited jobs');
  assert.equal(ready(h,first).summary.messages,60);assert.equal(s.eventCount(),60);
 }finally{s.close();}
});

test('simulcast category switches filter YouTube metrics and donations in raw, historical and reused reports',()=>{
 const s=new StreamStore(':memory:');try{
 const at=base+12*3600000,id=s.startSession('owner','categories',at,'platform',at);
 s.attachPlatformStream(id,'youtube','yt-owner','categories-video',at,at,null,'Same broadcast');
 s.streamSample(id,at,'dota','Dota 2','',10);s.youtubeViewers(at,4);
 s.streamSample(id,at+minute,'irl','IRL','',20);s.youtubeViewers(at+minute,8);
 s.youtubeMessages('yt-owner','chat',[{id:'dota-message',snippet:{type:'textMessageEvent',publishedAt:new Date(at+1000).toISOString()},authorDetails:{channelId:'viewer',displayName:'Viewer'}},{id:'irl-message',snippet:{type:'textMessageEvent',publishedAt:new Date(at+minute+1000).toISOString()},authorDetails:{channelId:'viewer',displayName:'Viewer'}}]);
 s.endSession(id,at+2*minute);
 const person=s.persons()[0]!.id as string;
 // Two tips in the same minute on opposite sides of a category change.
 s.streamSample(id,at+30000,'irl','IRL','',15);
 for(const [n,time] of [at+29999,at+30000,at+2*minute].entries())s.createDonation({personId:person,amount:String(n+1),currency:'RUB',occurredAtMs:time,message:'',sourceName:'Cash'},time);
 const db=(s as any).db,h=new AnalyticsHistory(db),opts={fromMs:at,toMs:at+3*minute,timezone:'UTC',ownerId:'owner',youtubeAccount:'yt-owner',source:'youtube' as const};
 for(const [category,count,amount] of [['dota',1,'100'],['irl',1,'200'],['missing',0,undefined]] as const){
  const query={...opts,category},raw=audienceAnalytics(db,query),cached=ready(h,query);
  assert.deepEqual(cached.donationTiming,raw.donationTiming);assert.deepEqual(h.report(query).donationTiming,raw.donationTiming);
  assert.equal(raw.donationTiming.count,count);assert.equal(raw.donationTiming.totals.RUB,amount);
  assert.deepEqual(cached.summary,raw.summary);assert.deepEqual(cached.streamComparison,raw.streamComparison);
  assert.deepEqual(raw.availableCategories.map(c=>c.name).sort(),['Dota 2','IRL']);
  if(category!=='missing'){assert.equal(raw.summary.messages,1);assert.equal(raw.streamComparison[0]!.viewers.youtube.mean,category==='dota'?4:20/3);assert.deepEqual(raw.streamComparison[0]!.categories,[category==='dota'?'Dota 2':'IRL']);}
 }
 assert.equal(ready(h,opts).donationTiming.count,3);
 }finally{s.close();}
});

test('closed query variants survive category switches and clock changes without rescanning samples; corrections invalidate them',t=>{
 const s=new StreamStore(':memory:');try{
 fixture(s);const db=(s as any).db,h=new AnalyticsHistory(db),prepare=db.prepare.bind(db);let scanned=0;
 db.prepare=(sql:string)=>{const statement=prepare(sql);if(sql.startsWith('SELECT * FROM stream_samples')){const all=statement.all.bind(statement);statement.all=(...args:any[])=>{const rows=all(...args);if(rows.length)scanned++;return rows;};}return statement;};
 const queries=['','game','missing'].map(category=>({...options,category}));
 const reports=queries.map(query=>h.query(query)),firstScans=scanned;assert.ok(firstScans>0);
 reports[0]!.audience[0]!.messages=999;
 t.mock.method(Date,'now',()=>options.toMs+100*86400000);
 for(let n=0;n<3;n++)for(const query of queries)assert.deepEqual(h.query(query).summary,audienceAnalytics(db,query).summary);
 // The comparison above deliberately reads raw facts; independently verify a cache-only pass.
 const before=scanned;for(const query of queries)h.query(query);assert.equal(scanned,before);
 assert.equal(h.query(queries[0]!).audience[0]!.messages,4);
 s.ingest({source:'twitch',accountId:'owner',externalId:'late-cached-category',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:base+minute,receivedAtMs:options.toMs,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{count:1}});
 assert.equal(h.query(queries[0]!).summary.messages,5);assert.ok(scanned>before);
 s.followingSnapshot('twitch','owner',[],true,base);h.query(queries[0]!);const beforeCheck=scanned;
 s.followingSnapshot('twitch','owner',[],true,base+minute);h.query(queries[0]!);assert.equal(scanned,beforeCheck,'unchanged follower checks do not rebuild the report');
 }finally{s.close();}
});

test('completed reports have fixed entry and byte budgets, and oversized reports remain correct',()=>{
 const s=new StreamStore(':memory:');try{
 fixture(s,1);const db=(s as any).db,h=new AnalyticsHistory(db,{maxCompletedBytes:200000});
 for(let minMessages=0;minMessages<12;minMessages++)h.query({...options,minMessages});
 const memory=h as any;assert.ok(memory.completed.size<=16);assert.ok(memory.completedBytes<=200000);
 const tiny=new AnalyticsHistory(db,{maxCompletedBytes:1});for(let i=0;i<2;i++)assert.equal(tiny.query(options).summary.messages,1);assert.equal((tiny as any).completed.size,0);
 }finally{s.close();}
});

test('background baking prepares actual category variants without adding facts or rewriting unchanged slices',()=>{
 const s=new StreamStore(':memory:');try{
 fixture(s,3);const db=(s as any).db,h=new AnalyticsHistory(db);let progress;do{progress=h.prepare(options);}while(progress.preparing);
 const rows=db.prepare('SELECT session_id,cache_key,payload,updated_at_ms FROM analytics_stream_cache ORDER BY session_id,cache_key').all();assert.equal(rows.length,6);
 for(const category of ['','game'])assert.equal(ready(h,{...options,category}).summary.messages,3);
 h.prepare(options);assert.deepEqual(db.prepare('SELECT session_id,cache_key,payload,updated_at_ms FROM analytics_stream_cache ORDER BY session_id,cache_key').all(),rows);assert.equal(s.eventCount(),3);
 }finally{s.close();}
});

test('summary queries reuse baked slices while day and stream drilldowns retain original minute facts',()=>{
 const s=new StreamStore(':memory:');try{
 fixture(s,4);const db=(s as any).db,raw=audienceAnalytics(db,options),summary=s.analytics({...options,summaryOnly:true}) as any;
 assert.equal(summary.aggregate,true);assert.deepEqual(summary.summary,raw.summary);assert.deepEqual(summary.streamComparison,raw.streamComparison);assert.deepEqual(summary.hours,raw.hours);
 const day=s.analytics({...options,toMs:base+86400000});assert.equal((day as any).aggregate,undefined);assert.equal(day.timeline.length,3);assert.ok(day.audience[0]!.intervals.length);
 const saved=db.prepare('SELECT count(*) n FROM analytics_stream_cache').get().n;for(let i=0;i<3;i++)assert.deepEqual(s.analytics({...options,summaryOnly:true}).summary,summary.summary);assert.equal(db.prepare('SELECT count(*) n FROM analytics_stream_cache').get().n,saved);
 }finally{s.close();}
});

test('follower corrections sharing a provider timestamp invalidate completed reports',()=>{
 const s=new StreamStore(':memory:');try{
 fixture(s,1);const db=(s as any).db,h=new AnalyticsHistory(db);
 s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:base}],true,base);
 assert.equal(h.query(options).composition.followers,1);
 s.followingSnapshot('twitch','owner',[],true,base);
 db.prepare("UPDATE follower_checks SET id='zzzz-new-check' WHERE rowid=(SELECT max(rowid) FROM follower_checks)").run();
 assert.equal(audienceAnalytics(db,options).composition.followers,0);assert.equal(h.query(options).composition.followers,0);
 }finally{s.close();}
});

test('large reports page people and clock attendance without changing global metrics or cohorts',()=>{
 const s=new StreamStore(':memory:');try{
  for(let n=0;n<3;n++){
   const at=base+n*86400000,id=s.startSession('owner',`paged-${n}`,at,'platform',at),ids=Array.from({length:125},(_,i)=>`viewer${String(i).padStart(3,'0')}`);
   s.streamSample(id,at,'game','Game','',125);s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+minute-1,status:'complete',userIds:ids,userNames:Object.fromEntries(ids.map(id=>[id,id]))});s.endSession(id,at+2*minute);
  }
  const db=(s as any).db,h=new AnalyticsHistory(db),opts={...options,summaryOnly:true,minMinutes:0,minMessages:0,minSessions:1},raw=audienceAnalytics(db,opts),r=ready(h,opts);
  assert.deepEqual(r.summary,raw.summary);assert.deepEqual(r.composition,raw.composition);assert.deepEqual(r.categories,raw.categories);assert.deepEqual(r.streamComparison,raw.streamComparison);
  assert.equal(r.audience.length,100);assert.equal(r.audiencePage.total,125);assert.ok(r.clockBuckets.every((b:any)=>b.peopleDeferred));
  const next=h.query({...opts,audienceOffset:100});assert.equal(next.audience.length,25);assert.equal(new Set([...r.audience,...next.audience].map(p=>p.id)).size,125);
  const found=h.query({...opts,audienceSearch:'viewer124',audienceSort:'sessions'});assert.equal(found.audiencePage?.total,1);assert.equal(found.audience[0]!.name,'viewer124');
  const bucket=r.clockBuckets.find((b:any)=>b.day==='all'&&b.resolution===1),q={...opts,clockDay:'all',clockMinute:bucket.minute,clockResolution:1};
  const first=h.query(q);assert.equal(first.clockVisitors?.total,125);assert.ok(first.clockVisitors!.items.every(p=>p.visits===3));assert.equal(h.query({...q,clockOffset:100}).clockVisitors?.items.length,25);
  const id=found.audience[0]!.id;s.setPersonMetadata(id,['Exact'],true,s.personRevision(id));assert.equal(ready(h,{...opts,audienceCoreOnly:true}).audiencePage.total,125);assert.equal(ready(h,{...opts,audienceSearch:'viewer124'}).audience[0].tags[0],'Exact');
  for(const bad of [{audienceOffset:-1},{clockOffset:0.5},{audienceSearch:'x'.repeat(257)},{audienceSort:'unsafe'},{clockDay:'never'},{clockResolution:7},{clockMinute:1440},{clockMinute:1,clockResolution:60}])assert.throws(()=>h.query({...opts,...bad}),/INVALID_ANALYTICS_FILTER/);
  h.close();assert.equal(db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE type='table' AND name LIKE 'sp_analytics_%'").get().n,0);
 }finally{s.close();}
});
test('live writes do not restart historical preparation, but invalidate the completed live snapshot',t=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,60);const at=base+61*86400000,live=s.startSession('owner','ongoing',at,'platform',at),h=new AnalyticsHistory((s as any).db),opts={...options,toMs:at+minute,summaryOnly:true};
  let cpu=0;t.mock.method(performance,'now',()=>cpu+=10);
  const first=h.report(opts);assert.equal(first.preparing,true);
  s.streamSample(live,at,'game','Game','',10);const second=h.report(opts);assert.ok(second.ready!>first.ready!);
  assert.equal(ready(h,opts).summary.streams,61);s.streamSample(live,at+1000,'game','Game','',12);assert.equal(h.report(opts).preparing,true);assert.equal(ready(h,opts).summary.messages,60);h.close();
 }finally{s.close();}
});

test('temporary-space pressure evicts only derived work and resource errors preserve all facts',t=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,60);const db=(s as any).db,h=new AnalyticsHistory(db,{maxReportBytes:0}),opts={...options,toMs:base+62*86400000,summaryOnly:true};
  assert.equal(ready(h,opts).summary.messages,60);
  const original=AnalyticsWorkspace.prototype.checkBudget;let fail=false,fatal='';
  t.mock.method(AnalyticsWorkspace.prototype,'checkBudget',function(this:AnalyticsWorkspace<unknown>){if(fatal)throw Error(fatal);if(fail){fail=false;throw Error('ANALYTICS_WORKSPACE_LIMIT');}return original.call(this);});
  fail=true;assert.equal(ready(h,{...opts,minMessages:100}).summary.messages,60,'completed derived work is safely evicted');h.close();
  let cpu=0;t.mock.method(performance,'now',()=>cpu+=10);
  assert.equal(h.report({...opts,minMessages:101}).preparing,true);fail=true;
  assert.equal(ready(h,{...opts,minMessages:102}).summary.messages,60,'another pending filter can be safely displaced');h.close();
  for(const error of ['ANALYTICS_WORKSPACE_LIMIT','ANALYTICS_DISK_RESERVE']){
   fatal=error;assert.throws(()=>h.report(opts),new RegExp(error));
   assert.equal(db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE type='table' AND name LIKE 'sp_analytics_%'").get().n,0);
  }
  fatal='';assert.equal(ready(h,opts).summary.messages,60);h.close();assert.equal(s.eventCount(),60);
 }finally{s.close();}
});

test('background warm prepares the landing report without speculative period and platform variants',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,4);const h=new AnalyticsHistory((s as any).db),toMs=Math.floor(options.toMs/60000)*60000;
  let progress;do{progress=h.warm({...options,toMs});}while(progress.preparing);
  const aggregate=(h as any).aggregate;(h as any).aggregate=()=>{throw Error('hot report rebuilt');};
  const landing=h.report({includeInsights:true,summaryOnly:true,category:'',source:'all',...options,fromMs:0,toMs});assert.equal(landing.preparing,undefined);assert.equal(landing.summary.messages,4);
  const slices=dbCount((s as any).db);assert.ok(slices<=4,'no speculative categories or platform copies');
 (h as any).aggregate=aggregate;h.close();
 }finally{s.close();}
});

function dbCount(db:any){return db.prepare('SELECT count(*) n FROM analytics_stream_cache').get().n;}

test('live collection is not precomputed and stream completion refreshes the landing report',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,1);const db=(s as any).db,h=new AnalyticsHistory(db);let r;do{r=h.warm(options);}while(r.preparing);
  const at=base+86400000,id=s.startSession('owner','live',at,'platform',at);s.streamSample(id,at,'game','Game','',20);
  const aggregate=(h as any).aggregate;(h as any).aggregate=()=>{throw Error('collector competed with background');};assert.equal(h.warm(options).preparing,false);
  (h as any).aggregate=aggregate;s.endSession(id,at+minute);do{r=h.warm(options);}while(r.preparing);
  assert.equal(ready(h,{...options,fromMs:0,source:'all',category:'',summaryOnly:true,includeInsights:true}).summary.streams,2);h.close();
 }finally{s.close();}
});

test('rolling boundaries keep exact partial-stream metrics and reuse all unaffected slices',()=>{
 const s=new StreamStore(':memory:');try{
  const now=base+7*86400000,at=base-3600000,id=s.startSession('owner','boundary',at,'platform',at);
  for(let n=0;n<4;n++)s.streamSample(id,at+n*3600000,'game','Game','',10+n);s.endSession(id,at+4*3600000);
  const recent=s.startSession('owner','recent',base+86400000,'platform',base+86400000);s.streamSample(recent,base+86400000,'game','Game','',20);s.endSession(recent,base+86400000+minute);
  const db=(s as any).db,h=new AnalyticsHistory(db),opts={...options,fromMs:now-7*86400000,toMs:now,summaryOnly:true};ready(h,opts);
  const build=(h as any).build.bind(h),built:string[]=[];(h as any).build=(opts:any,session:any)=>{built.push(session.id);return build(opts,session);};
  const shifted={...opts,fromMs:opts.fromMs+minute,toMs:opts.toMs+minute},result=ready(h,shifted),raw=audienceAnalytics(db,shifted);
  assert.deepEqual(built,[id]);assert.deepEqual(result.summary,raw.summary);assert.deepEqual(result.hours,raw.hours);assert.deepEqual(result.streamComparison,raw.streamComparison);h.close();
 }finally{s.close();}
});

test('idle warming never rebuilds rolling boundaries inside old four-hour streams',()=>{
 const s=new StreamStore(':memory:');try{
  const now=base+40*86400000+3600000;
  for(const days of [7,30,35]){
   const at=now-days*86400000-3600000,id=s.startSession('owner',String(days),at,'platform',at);
   s.streamSample(id,at,'game','Game','',10);s.endSession(id,at+4*3600000);
  }
  const h=new AnalyticsHistory((s as any).db);let result;do{result=h.warm({...options,toMs:now});}while(result.preparing);
  const snapshots=(s as any).db.prepare('SELECT * FROM analytics_reports').all();
  (h as any).aggregate=()=>{throw Error('idle aggregation');};(h as any).build=()=>{throw Error('idle stream rebuild');};
  for(let minute=1;minute<=1440;minute++)assert.equal(h.warm({...options,toMs:now+minute*60000}).preparing,false);
  assert.deepEqual((s as any).db.prepare('SELECT * FROM analytics_reports').all(),snapshots);
  h.close();
 }finally{s.close();}
});

test('persisted reports retain all audience and clock pages after connection-local workspaces close',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.startSession('owner','persisted',base,'platform',base),ids=Array.from({length:125},(_,i)=>`viewer${String(i).padStart(3,'0')}`);
  s.streamSample(id,base,'game','Game','',125);s.recordPoll(id,'owner',{startedAtMs:base,completedAtMs:base+minute,status:'complete',userIds:ids,userNames:Object.fromEntries(ids.map(id=>[id,id]))});s.endSession(id,base+2*minute);
  const db=(s as any).db,opts={...options,summaryOnly:true,includeInsights:true},h=new AnalyticsHistory(db),first=ready(h,opts);
  const second=ready(h,{...opts,audienceOffset:100}),clock=h.clockAudience({...opts,clockMinute:180,clockResolution:30,clockDay:'all',clockBatch:true});h.close();
  const reopened=new AnalyticsHistory(db);(reopened as any).aggregate=()=>{throw Error('persisted report rebuilt');};
  assert.deepEqual(reopened.report(opts),first);assert.deepEqual(reopened.report({...opts,audienceOffset:100}),second);
  assert.deepEqual(reopened.clockAudience({...opts,clockMinute:180,clockResolution:30,clockDay:'all',clockBatch:true}),clock);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE type IN('table','view') AND name LIKE 'sp_analytics_%'").get().n,0);
  reopened.close();
 }finally{s.close();}
});

test('a corrected stream rebuilds only its derived slice and replaces the durable report',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,4);const db=(s as any).db,opts={...options,summaryOnly:true},h=new AnalyticsHistory(db);ready(h,opts);h.close();
  const session=String(s.sessions().at(-1)!.id);s.streamSample(session,base,'game','Game','',20);
  const changed=new AnalyticsHistory(db),build=(changed as any).build.bind(changed),built:string[]=[];
  (changed as any).build=(opts:any,session:any)=>{built.push(session.id);return build(opts,session);};
  const report=ready(changed,opts);assert.deepEqual(built,[session]);assert.deepEqual(report.summary,audienceAnalytics(db,opts).summary);
  assert.equal(db.prepare('SELECT count(*) n FROM analytics_reports').get().n,1);changed.close();
 }finally{s.close();}
});

test('late collection gaps invalidate persisted insight evidence without rebuilding stream facts',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,4);const db=(s as any).db,opts={...options,summaryOnly:true,includeInsights:true},h=new AnalyticsHistory(db);ready(h,opts);h.close();
  s.gap('twitch','late correction',base,base+minute);
  const corrected=new AnalyticsHistory(db),aggregate=(corrected as any).aggregate.bind(corrected);let rebuilt=0;
  (corrected as any).aggregate=(...args:any[])=>{rebuilt++;return aggregate(...args);};(corrected as any).build=()=>{throw Error('unchanged stream facts rebuilt');};
  assert.equal(ready(corrected,opts).summary.messages,4);assert.equal(rebuilt,1);corrected.close();
 }finally{s.close();}
});

test('reopened reports refresh independent channel snapshots and offline donations without rebuilding attendance',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,1);const db=(s as any).db,h=new AnalyticsHistory(db),opts={...options,summaryOnly:true,youtubeAccount:'yt-owner'};
  const first=ready(h,opts);ready(h,{...opts,source:'twitch'});h.close();
  s.youtubeSnapshot('yt-owner','report',{rows:[[99]]},options.toMs);
  s.createDonation({personId:first.audience[0]!.id,amount:'2',currency:'RUB',occurredAtMs:options.toMs-1000,message:'Offline',sourceName:'Cash'},options.toMs-1000);
  const reopened=new AnalyticsHistory(db);(reopened as any).aggregate=()=>{throw Error('unchanged attendance rebuilt');};
  const all=reopened.report(opts);assert.deepEqual(all.youtubeReport?.data.rows,[[99]]);assert.deepEqual(all.donationTiming.totals,{RUB:'200'});
  assert.equal(reopened.report({...opts,source:'twitch'}).youtubeReport,null);
  assert.equal(reopened.clockAudience(opts).clockVisitors!.total,0);
  assert.ok(reopened.clockAudience({...opts,clockBatch:true}).clockPages!.some(p=>p.minute===180&&p.page.total===1));reopened.close();
 }finally{s.close();}
});

test('damaged report or stream cache rebuilds from intact source facts without losing audience membership',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,2);const db=(s as any).db,opts={...options,summaryOnly:true},h=new AnalyticsHistory(db),first=ready(h,opts);h.close();
  db.prepare('UPDATE analytics_reports SET payload=?').run(Buffer.from('damaged report'));
  const second=new AnalyticsHistory(db);assert.deepEqual(ready(second,opts).summary,first.summary);second.close();
  db.prepare('DELETE FROM analytics_reports').run();db.prepare('UPDATE analytics_stream_cache SET payload=?').run(Buffer.from('damaged stream'));
  const third=new AnalyticsHistory(db);assert.deepEqual(ready(third,opts).summary,first.summary);assert.equal(s.eventCount(),2);assert.deepEqual(db.pragma('foreign_key_check'),[]);third.close();
 }finally{s.close();}
});

test('cold clock drilldown advances bounded preparation and never returns the full audience payload',t=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,20);const h=new AnalyticsHistory((s as any).db),opts={...options,toMs:base+21*86400000,summaryOnly:true,includeInsights:true,clockBatch:true,clockMinute:180,clockResolution:30,clockDay:'all'};
  let cpu=0;t.mock.method(performance,'now',()=>cpu+=25);let result=h.clockAudience(opts),pending=0;
  assert.equal(result.preparing,true);
  while(result.preparing){assert.equal('audience' in result,false);assert.equal('timeline' in result,false);assert.ok(++pending<100);result=h.clockAudience(opts);}
  assert.ok(result.clockPages!.some(p=>p.minute===180&&p.page.total===1));h.close();
 }finally{s.close();}
});

test('empty history remains readable when both memory and persistent report budgets are exhausted',()=>{
 const s=new StreamStore(':memory:');try{
  const h=new AnalyticsHistory((s as any).db,{maxCompletedBytes:1,maxReportBytes:0}),opts={fromMs:0,toMs:1};
  for(let n=0;n<2;n++){assert.equal(ready(h,opts).summary.streams,0);assert.deepEqual(h.clockAudience(opts).clockVisitors!.items,[]);assert.equal(h.clockAudience({...opts,clockBatch:true}).clockPages!.length,24);}
  h.close();
 }finally{s.close();}
});

test('clock endpoint returns only prepared visitor pages and corrections replace stale membership',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,3);const h=new AnalyticsHistory((s as any).db),opts={...options,summaryOnly:true,includeInsights:true},report=ready(h,opts),query={...opts,clockMinute:180,clockResolution:30,clockDay:'all',clockBatch:true};
  let result=h.clockAudience(query);assert.equal(result.preparing,undefined);assert.equal(result.clockPages!.length,48);
  assert.equal('timeline' in result,false);assert.equal('audience' in result,false);assert.deepEqual(result.clockPages!.find(p=>p.minute===180)!.page,h.query({...query,clockBatch:false}).clockVisitors);
  const person=report.audience[0].id;s.renamePerson(person,'New name');
  do{result=h.clockAudience(query);}while(result.preparing);
  assert.equal(result.clockPages!.find(p=>p.minute===180)!.page.items[0]!.name,'New name');
  assert.equal(h.clockAudience({...query,clockBatch:false,clockOffset:100}).clockVisitors!.items.length,0);
  h.close();
 }finally{s.close();}
});


test('small rolling reports defer clock membership and keep exact clipped metrics and lazy attendance',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,4);const h=(s as any).history as AnalyticsHistory;
  const original=AnalyticsWorkspace.prototype.clockPage;let membershipReads=0;
  AnalyticsWorkspace.prototype.clockPage=function(...args:Parameters<typeof original>){membershipReads++;return original.apply(this,args);};
  try{
   for(const offset of [minute,minute+12345,2*minute]){
    const opts={...options,fromMs:base+offset,summaryOnly:true};const report=ready(h,opts),raw=audienceAnalytics((s as any).db,opts);
    assert.equal(membershipReads,0,'opening a report must not query every clock interval');
    assert.deepEqual(report.summary,raw.summary);assert.deepEqual(report.hours,raw.hours);assert.deepEqual(report.streamComparison,raw.streamComparison);
    assert.ok(report.clockBuckets.every((b:any)=>b.peopleDeferred&&b.people.length===0));
   }
   const opts={...options,summaryOnly:true},r=ready(h,opts),bucket=r.clockBuckets.find((b:any)=>b.day==='all'&&b.resolution===60&&b.peopleDeferred);
   const result=h.clockAudience({...opts,clockDay:bucket.day,clockResolution:bucket.resolution,clockMinute:bucket.minute});
   assert.equal(result.clockVisitors!.total,1);assert.equal(result.clockVisitors!.items[0]!.visits,4);assert.equal(membershipReads,1);
  }finally{AnalyticsWorkspace.prototype.clockPage=original;}
 }finally{s.close();}
});

test('background category catch-up advances once per call and never revisits completed reports',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,3);const h=(s as any).history as AnalyticsHistory,seen:string[]=[];
  const report=(h as any).warmReport.bind(h);(h as any).warmReport=(opts:any)=>{seen.push(opts.category);return report(opts);};
  assert.equal(h.warm(options,true).preparing,true);assert.deepEqual(seen,['']);
  assert.equal(h.warm({...options,toMs:options.toMs+60000},true).preparing,false);assert.deepEqual(seen,['','game']);
  for(let i=0;i<10;i++)assert.equal(h.warm({...options,toMs:options.toMs+(i+2)*60000},true).preparing,false);
  assert.deepEqual(seen,['','game']);
  s.streamSample(String(s.sessions()[0]!.id),base,'other','Other','',2);
  let progress;do{progress=h.warm(options,true);}while(progress.preparing);
  assert.deepEqual(seen.slice(2),['','game','other']);
 }finally{s.close();}
});

test('closed stream reports survive changing request times and restart, while revisions and filters stay exact',()=>{
 const s=new StreamStore(':memory:');try{
  fixture(s,1);const db=(s as any).db,sid=s.sessions()[0]!.id as string;let facts=0;
  const tracked=new Proxy(db,{get(target,property){if(property==='prepare')return(sql:string)=>{if(/FROM presence_polls|FROM effective_events|FROM events e/i.test(sql))facts++;return target.prepare(sql);};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
  const h=new AnalyticsHistory(tracked),opts={...options,sessionId:sid};
  const first=h.query(opts);assert.deepEqual(first,audienceAnalytics(db,opts));const reads=facts;
  first.audience[0]!.name='mutated';assert.equal(h.query({...opts,toMs:opts.toMs+60000}).audience[0]!.name,'Viewer');assert.equal(facts,reads);
  const restarted=new AnalyticsHistory(tracked);assert.deepEqual(restarted.query(opts),audienceAnalytics(db,opts));assert.equal(facts,reads,'restart uses the persisted projection');
  const partial={...opts,fromMs:base+minute};assert.deepEqual(h.query(partial),audienceAnalytics(db,partial));
  s.renamePerson(first.audience[0]!.id,'Renamed');assert.equal(h.query(opts).audience[0]!.name,'Renamed');
  s.ingest({source:'twitch',accountId:'owner',externalId:'late-session',type:'chat.message',actor:{externalId:'viewer',displayName:'Renamed'},occurredAtMs:base+minute,receivedAtMs:options.toMs,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'late'}});
  assert.deepEqual(h.query(opts),audienceAnalytics(db,opts));assert.equal(h.query(opts).summary.messages,2);
  s.setPersonMetadata(first.audience[0]!.id,['tag'],false,s.personRevision(first.audience[0]!.id));assert.deepEqual(h.query(opts),audienceAnalytics(db,opts));
  s.followingSnapshot('twitch','owner',[{id:'viewer',name:'Renamed',followedAtMs:base}],true,opts.toMs);assert.deepEqual(h.query(opts),audienceAnalytics(db,opts));
  assert.throws(()=>h.query({...opts,toMs:base}),/INVALID_ANALYTICS_FILTER/);
  const live=s.startSession('owner','live',options.toMs,'platform',options.toMs);const liveOpts={...opts,sessionId:live,toMs:options.toMs+minute};h.query(liveOpts);const liveReads=facts;h.query(liveOpts);assert.ok(facts>liveReads,'live streams do not reuse closed-stream projections');
 }finally{s.close();}
});
