import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {audienceAnalytics,analyticsMetadata} from '../src/analytics.js';
import {classifyCore,coreSessions} from '../src/core-classification.js';
const at=Date.UTC(2026,9,1),m=60000;
test('dense YouTube chat is grouped before core limits, even in a clipped Twitch report',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.observePlatformStream('youtube','yt','video',at,at,null,'Stream')!;
  s.youtubeMessages('yt','chat',[{id:'seed',snippet:{type:'textMessageEvent',publishedAt:new Date(at+1000).toISOString()},authorDetails:{channelId:'viewer',displayName:'Viewer'}}]);s.endSession(id,at+60*m);
  const db=(s as any).db;
  db.exec(`WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50000) INSERT INTO youtube_messages SELECT 'bulk-'||i,account_id,chat_id,author_id,published_at_ms+(i%1000),payload_json FROM n CROSS JOIN youtube_messages WHERE id='seed'`);
  const q={fromMs:at,toMs:at+60*m,youtubeAccount:'yt'};
  const report=audienceAnalytics(db,q);assert.equal(report.summary.messages,50001);assert.equal(report.audience.length,1);
  assert.doesNotThrow(()=>audienceAnalytics(db,{...q,toMs:at+m,source:'twitch'}));
 }finally{s.close();}
});
test('core rule and bounded session identifiers retain exact counts',()=>{
 assert.equal(classifyCore(44,200,25,null),false);assert.equal(classifyCore(44,200,22,null),true);assert.equal(classifyCore(0,200,0,null),false);assert.equal(classifyCore(0,0,80,true),true);
 const ids=Array.from({length:101},(_,i)=>String(i));const row=coreSessions(ids,101);assert.equal(row.coreAttendanceCount,101);assert.equal(row.coreSessionIds.length,100);assert.equal(row.coreSessionIdsTruncated,true);
 assert.equal(analyticsMetadata({fromMs:at,toMs:at+m}).summary.entities,0);
});
test('full-stream report shares one presence grouping pass',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.startSession('owner','stream',at,'platform',at);s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+m,status:'complete',userIds:['viewer']});s.endSession(id,at+10*m);
  const db=(s as any).db,prepare=db.prepare.bind(db);let count=0;db.prepare=(sql:string)=>{if(sql.startsWith('WITH raw AS'))count++;return prepare(sql);};
  audienceAnalytics(db,{fromMs:at,toMs:at+10*m});assert.equal(count,1);
 }finally{s.close();}
});
test('person picker searches beyond 500 without computing event statistics',()=>{
 const s=new StreamStore(':memory:');try{
  const db=(s as any).db;db.transaction(()=>{for(let i=0;i<510;i++){const id='person-'+String(i).padStart(3,'0');db.prepare('INSERT INTO persons(id,display_name) VALUES(?,?)').run(id,'Viewer '+String(i).padStart(3,'0'));}})();
  const first=s.personOptions('',0,50,true,'person-509');assert.equal(first.items.length,50);assert.equal(first.total,510);assert.equal(first.selectedItem?.id,'person-509');
  assert.equal(s.personOptions('509',0,50,true).items[0]?.id,'person-509');assert.equal(s.personOptions('',500,50,true).items.length,10);
  assert.throws(()=>s.personOptions('',-1),/INVALID_PERSON_PAGE/);assert.throws(()=>s.personOptions('',0,51),/INVALID_PERSON_PAGE/);
 }finally{s.close();}
});
test('person day projection returns only that person and exact presence coverage',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=s.startSession('owner','day',at,'platform',at);s.recordPoll(sid,'owner',{startedAtMs:at,completedAtMs:at+m,status:'complete',userIds:['one','two'],userNames:{one:'One',two:'Two'}});s.endSession(sid,at+10*m);
  const id=String(s.persons().find(p=>p.display_name==='One')!.id),q={fromMs:at,toMs:at+10*m};
  const full=s.analytics(q),detail=s.personAnalytics(id,q);assert.equal(detail.audience.length,1);assert.deepEqual(detail.audience[0]?.intervals,full.audience.find(p=>p.id===id)?.intervals);assert.deepEqual(detail.timeline,full.timeline.map(p=>({at:p.at,presenceKnown:p.presenceKnown})));
  assert.throws(()=>s.personAnalytics('missing',q),/PERSON_NOT_FOUND/);
 }finally{s.close();}
});
test('aggregated qualified IDs agree with count across finished streams',()=>{
 const s=new StreamStore(':memory:');try{
  for(let i=0;i<2;i++){const start=at+i*86400000,id=s.startSession('owner',String(i),start,'platform',start);s.recordPoll(id,'owner',{startedAtMs:start,completedAtMs:start+m,status:'complete',userIds:['viewer']});s.endSession(id,start+2*m);}
  let report:any;do{report=s.analytics({fromMs:at,toMs:at+3*86400000,summaryOnly:true});}while(report.preparing);
  assert.equal(report.audience[0].coreSessionIds.length,2);assert.equal(report.audience[0].coreAttendanceCount,2);assert.equal(report.audience[0].coreSessionIdsTruncated,false);
 }finally{s.close();}
});
test('cache hits avoid full history enumeration and irrelevant finance grouping',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.startSession('owner','cache',at,'platform',at);s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+m,status:'complete',userIds:['viewer']});s.endSession(id,at+2*m);
  const db=(s as any).db,prepare=db.prepare.bind(db);let history=0,finance=0;db.prepare=(sql:string)=>{const statement=prepare(sql);return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);if(key==='all')return(...args:unknown[])=>{if(sql.includes('SELECT s.id,s.started_at_ms,s.ended_at_ms,coalesce'))history++;if(sql.startsWith('SELECT cast(e.occurred_at_ms/60000'))finance++;return value.apply(target,args);};return typeof value==='function'?value.bind(target):value;}});};
  const q={fromMs:at,toMs:at+10*m,summaryOnly:true,panel:'audience' as const};let report:any;do{report=s.analytics(q);}while(report.preparing);history=0;finance=0;
  assert.equal(s.analytics({...q,audienceSearch:'viewer'}).summary.streams,1);assert.equal(history,0);assert.equal(finance,0);
  const viewer=String(s.persons()[0]!.id);s.createPersonNote(viewer,'Unrelated note',at);s.youtubeSnapshot('yt','channel',{count:3},at);s.analytics({...q,audienceSearch:'viewer'});assert.equal(history,0);
  s.setPersonMetadata(viewer,['Updated'],false,s.personRevision(viewer));
  do{report=s.analytics(q);}while(report.preparing);assert.equal(report.summary.core,0);assert.deepEqual(report.audience[0].tags,['Updated']);
 }finally{s.close();}
});
test('category clipping preserves linked platform membership without inventing attendance',()=>{
 const s=new StreamStore(':memory:');try{
  const sid=s.startSession('owner','categories',at,'platform',at);s.attachPlatformStream(sid,'youtube','yt','video',at,at,null,'Video');s.streamSample(sid,at,'game','Game','',4);s.streamSample(sid,at+10*m,'talk','Talk','',4);
  s.recordPoll(sid,'owner',{startedAtMs:at,completedAtMs:at+m,status:'complete',userIds:['viewer'],userNames:{viewer:'Viewer'}});
  s.youtubeMessages('yt','chat',[{id:'link',snippet:{type:'textMessageEvent',publishedAt:new Date(at+9*m).toISOString()},authorDetails:{channelId:'yt-viewer',displayName:'Viewer'}}]);s.endSession(sid,at+20*m);
  const r=s.analytics({fromMs:at,toMs:at+20*m,youtubeAccount:'yt',category:'talk'});assert.equal(r.audience[0]?.observedMinutes,0);assert.deepEqual(r.audience[0]?.sources,['twitch','youtube']);assert.equal(r.composition.both,1);
 }finally{s.close();}
});
