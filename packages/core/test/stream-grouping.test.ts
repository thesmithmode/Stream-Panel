import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
const m=60000,at=Date.UTC(2026,9,1,12);
type Grouping={mergeSessions(ids:string[]):string;unmergeSessions(id:string):void};
const grouping=(s:StreamStore)=>s as StreamStore&Grouping;
function part(s:StreamStore,n:number){
 const start=at+n*120*m,id=s.startSession('owner',`part-${n}`,start,'platform',start);
 s.streamSample(id,start,'game','Game',`Part ${n}`,n?8:4);
 s.recordPoll(id,'owner',{startedAtMs:start,completedAtMs:start+m,status:'complete',userIds:['viewer'],userNames:{viewer:'Viewer'}});
 s.ingest({source:'twitch',accountId:'owner',externalId:`message-${n}`,type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:start+m,receivedAtMs:start+m,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{originChannelId:'owner'}});
 s.ingest({source:'donationalerts',accountId:'da',externalId:`tip-${n}`,type:'donation',actor:{externalId:'name:donor',displayName:'Donor'},occurredAtMs:start+m,receivedAtMs:start+m,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}});
 s.endSession(id,start+2*m);return id;
}
const options={fromMs:at,toMs:at+250*m,summaryOnly:true};
test('automatic continuation includes exactly 60 minutes and rejects a longer gap or another account',()=>{
 for(const [gap,account,expected]of [[59*m,'owner',true],[60*m,'owner',true],[60*m+1,'owner',false],[m,'other',false]] as const){
  const s=new StreamStore(':memory:');try{const id=s.observePlatformStream('twitch','owner','old',at,at,null,'')!;s.endSession(id,at+m);
   const next=s.observePlatformStream('twitch',account,'new',at+m+gap,at+m+gap,null,'',['new']);assert.equal(next===id,expected);
  }finally{s.close();}
 }
});
test('a confirmed replacement whose platform start overlaps the last observation still continues',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.observePlatformStream('twitch','owner','old',at,at+2*m,null,'')!;
  assert.equal(s.observePlatformStream('twitch','owner','next',at+m,at+3*m,null,'',['next']),id);
  assert.equal(s.platformStreams(id).length,2);assert.equal(s.sessions().length,1);
 }finally{s.close();}
});
test('manual grouping is reversible and preserves every original session, event and foreign key across reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-group-')),path=join(dir,'db');let s=new StreamStore(path);
 try{
  const a=part(s,0),b=part(s,1),raw=new Database(path);
  const snapshot=()=>Object.fromEntries(['sessions','events','event_sessions','platform_streams','presence_polls','presence_members','stream_samples'].map(table=>[table,raw.prepare(`SELECT * FROM ${table}`).all()]));
  const before=snapshot();assert.equal(s.analytics(options).summary.streams,2);
  const root=grouping(s).mergeSessions([b,a]);assert.equal(root,a);assert.deepEqual(snapshot(),before);
  assert.equal(s.sessions().length,1);assert.equal(s.channelOverview().streams,1);
  const card=s.sessions()[0]!;assert.equal(card.messageCount,2);assert.equal(card.donationCount,2);assert.deepEqual(card.donationTotals,{RUB:'200'});assert.equal(card.durationMs,4*m);
  assert.deepEqual(card.breaks,[{from:at+2*m,to:at+120*m}]);
  assert.equal(s.summary(root,[],false).messages,2);assert.equal(s.donations(undefined,0,50,false,root).total,2);
  for(const summaryOnly of [false,true]){
   const report=s.analytics({...options,summaryOnly});assert.equal(report.summary.streams,1);assert.equal(report.summary.messages,2);
   const viewer=report.audience.find(p=>p.name==='Viewer')!;assert.equal(viewer.attendanceSessionIds.length,1);assert.equal(viewer.attendanceRatio,1);
   assert.equal(report.streamComparison.length,1);assert.equal(report.streamComparison[0]!.durationMs,4*m);
  }
  assert.equal(s.analytics({...options,sessionId:root}).summary.messages,2);
  const backup=join(dir,'copy.sqlite');await s.backup(backup);const restored=new StreamStore(backup);try{assert.equal(restored.sessions().length,1);assert.equal(restored.summary(root,[],false).messages,2);}finally{restored.close();}
  s.close();s=new StreamStore(path);assert.equal(s.sessions().length,1);
  grouping(s).unmergeSessions(root);assert.equal(s.sessions().length,2);assert.equal(s.analytics(options).summary.streams,2);assert.deepEqual(snapshot(),before);
  assert.deepEqual(raw.pragma('foreign_key_check'),[]);assert.equal(raw.pragma('integrity_check',{simple:true}),'ok');raw.close();
 }finally{s.close();await rm(dir,{recursive:true,force:true});}
});
test('groups expand without nesting, and invalid or active selections are atomic',()=>{
 const s=new StreamStore(':memory:');try{
  const a=part(s,0),b=part(s,1),c=part(s,2),g=grouping(s);
  for(const ids of [[],[a],[a,a],[a,'missing']])assert.throws(()=>g.mergeSessions(ids));
  assert.equal(s.sessions().length,3);assert.equal(g.mergeSessions([a,b]),a);assert.equal(g.mergeSessions([b,c]),a);assert.equal(s.sessions().length,1);
  g.unmergeSessions(a);assert.equal(s.sessions().length,3);
  const live=s.observePlatformStream('twitch','elsewhere','live',at+400*m,at+400*m,null,'')!;
  assert.throws(()=>g.mergeSessions([a,live]),/INVALID_SESSION_GROUP/);assert.equal(s.sessions().length,4);
 }finally{s.close();}
});
test('group writes and derived reads remain isolated between profiles in one SQLite file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-group-profiles-')),path=join(dir,'db'),a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
 try{const x=part(a,0),y=part(a,1),foreign=part(b,0);assert.throws(()=>grouping(a).mergeSessions([x,foreign]));
  grouping(a).mergeSessions([x,y]);assert.equal(a.sessions().length,1);assert.equal(b.sessions().length,1);assert.equal(b.sessions()[0]!.id,foreign);assert.equal(b.analytics(options).summary.messages,1);
 }finally{a.close();b.close();await rm(dir,{recursive:true,force:true});}
});
test('late facts in a grouped child invalidate warmed history in another connection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-group-cache-')),path=join(dir,'db'),writer=new StreamStore(path),reader=new StreamStore(path);
 try{
  const a=part(writer,0),b=part(writer,1);assert.equal(reader.analytics(options).summary.streams,2);
  grouping(writer).mergeSessions([a,b]);assert.equal(reader.analytics(options).summary.streams,1);assert.equal(reader.analytics(options).summary.messages,2);
  writer.ingest({source:'twitch',accountId:'owner',externalId:'late-message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at+121*m,receivedAtMs:at+240*m,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{originChannelId:'owner'}});
  assert.equal(reader.analytics(options).summary.messages,3);assert.equal(reader.analytics({...options,sessionId:b}).summary.messages,3);
  grouping(writer).unmergeSessions(a);assert.equal(reader.analytics(options).summary.streams,2);assert.equal(reader.analytics(options).summary.messages,3);
 }finally{writer.close();reader.close();await rm(dir,{recursive:true,force:true});}
});
test('group follower totals exclude subscriptions during an offline break',()=>{
 const s=new StreamStore(':memory:');try{
  const a=part(s,0),b=part(s,1);
  s.followingSnapshot('twitch','owner',[{id:'gap',name:'Gap',followedAtMs:at+30*m},{id:'live',name:'Live',followedAtMs:at+121*m}],true,at+122*m);
  const root=grouping(s).mergeSessions([a,b]);assert.deepEqual(s.followingAnalytics(root).newFollowers.map(p=>p.externalId),['live']);
 }finally{s.close();}
});
test('unsafe selections reject overlaps, manual sessions and oversized groups without changing history',()=>{
 const s=new StreamStore(':memory:');try{
  const a=part(s,0),g=grouping(s);
  const overlap=s.startSession('other','overlap',at+m,'platform',at+m);s.endSession(overlap,at+3*m);
  const manual=s.startSession('manual','manual',at+10*m,'manual',at+10*m);s.endSession(manual,at+11*m);
  const far=s.startSession('other','far',at+32*86400000,'platform',at+32*86400000);s.endSession(far,at+32*86400000+m);
  for(const ids of [[a,overlap],[a,manual],[a,far],['',a],Array.from({length:101},(_,n)=>String(n)),[a,42] as unknown as string[]])assert.throws(()=>g.mergeSessions(ids),/INVALID_SESSION_GROUP/);
  assert.throws(()=>g.unmergeSessions(a),/SESSION_GROUP_NOT_FOUND/);assert.equal(s.sessions().length,4);
 }finally{s.close();}
});
test('YouTube inferred minutes and person activity stop at each physical broadcast end',()=>{
 const s=new StreamStore(':memory:');try{
  const ids:string[]=[];
  for(let n=0;n<2;n++){
   const start=at+n*120*m,id=s.startSession('owner',`boundary-${n}`,start,'platform',start);ids.push(id);
   s.attachPlatformStream(id,'youtube','yt',`video-${n}`,start,start,null,'Video');
   s.youtubeMessages('yt',`chat-${n}`,[{id:`yt-${n}`,snippet:{type:'textMessageEvent',publishedAt:new Date(start+m).toISOString()},authorDetails:{channelId:'yt-viewer',displayName:'YouTubeViewer'}}]);
   s.recordPoll(id,'owner',{startedAtMs:start,completedAtMs:start+2*m,status:'complete',userIds:['viewer'],userNames:{viewer:'Viewer'}});
   s.endSession(id,start+2*m);
  }
  const root=grouping(s).mergeSessions(ids),youtube=String(s.persons().find(p=>p.display_name==='YouTubeViewer')!.id),twitch=String(s.persons().find(p=>p.display_name==='Viewer')!.id);
  assert.equal(s.personStats(youtube,root).estimatedChatMinutes,2);
  assert.equal(s.personActivity(twitch).visits.reduce((sum,v)=>sum+v.minutes,0),4);
  assert.equal(s.analytics({...options,sessionId:root,youtubeAccount:'yt'}).audience.find(p=>p.id===youtube)!.estimatedChatMinutes,2);
 }finally{s.close();}
});
