import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';

test('schema upgrade repairs affected merged projections and retains unrelated stream facts byte for byte',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-service-upgrade-')),path=join(dir,'data.sqlite'),now=Date.now();let s=new StreamStore(path,'ruslan');
 try{
  const ids:string[]=[];
  for(const [n,user] of ['human','jeetbot','unrelated'].entries()){
   const at=now-(4-n)*86400000,id=s.startSession('owner',String(n),at,'platform',at);ids.push(id);
   s.streamSample(id,at,'game','Game','',10);s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+60000,status:'complete',userIds:[user]});s.endSession(id,at+60000);
  }
  const merged=s.mergeSessions(ids.slice(0,2)),stable=ids[2]!;
  s.analytics({sessionId:merged,fromMs:0,toMs:now});s.analytics({sessionId:stable,fromMs:0,toMs:now});
  const db=(s as unknown as {db:Database.Database}).db;
  const version=db.prepare('SELECT * FROM analytics_fact_versions WHERE session_id=?').get(stable);
  const payload=db.prepare('SELECT payload FROM analytics_stream_facts WHERE session_id=?').get(stable);
  const rawCount=db.prepare('SELECT count(*) n FROM presence_members_compact').get();
  db.exec('DROP VIEW service_people;PRAGMA user_version=34;');s.close();s=new StreamStore(path,'ruslan');
  const next=(s as unknown as {db:Database.Database}).db;
  assert.deepEqual(next.prepare('SELECT * FROM analytics_fact_versions WHERE session_id=?').get(stable),version);
  assert.deepEqual(next.prepare('SELECT payload FROM analytics_stream_facts WHERE session_id=?').get(stable),payload);
  assert.deepEqual(next.prepare('SELECT count(*) n FROM presence_members_compact').get(),rawCount);
  assert.equal(next.prepare('SELECT payload FROM analytics_stream_facts WHERE session_id=?').get(merged),undefined);
  assert.deepEqual(s.analytics({sessionId:merged,fromMs:0,toMs:now,excludedLogins:false}).audience.map(p=>p.name),['human']);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('service accounts and owners stay hidden in both modes and never reduce measured online as audience bots',()=>{
 const s=new StreamStore(':memory:'),at=Date.now()-600000,minute=60000;
 try{
  const sid=s.startSession('owner','service-regression',at,'platform',at);
  const users=['owner','jeetbot','streamer_bot','streamelements','suspect','viewer'];
  const people=new Map<string,string>();
  for(const user of users){
   const id=s.ingest({source:'twitch',accountId:'owner',externalId:user,type:'chat.message',actor:{externalId:user,displayName:user},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}}).personId!;
   people.set(user,id);
  }
  const suspect=people.get('suspect')!;
  s.setPersonBot(suspect,true,s.personRevision(suspect));
  // A previous human/neutral override must not bring operational bots back.
  const service=people.get('jeetbot')!;
  s.setPersonHuman(service,true,s.personRevision(service));
  s.recordPoll(sid,'owner',{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:users});
  s.streamSample(sid,at,'game','Game','',11);
  s.followingSnapshot('twitch','owner',users.map(id=>({id,name:id,followedAtMs:at+1000})),true,at+30000);
  for(const excluded of [false,[]] as (false|string[])[]){
   const all=excluded===false;
   const live=s.currentChat(sid,excluded,true,at+minute);
   assert.deepEqual(live.people.map(p=>p.personId).sort(),[suspect,people.get('viewer')!].sort());
   const list=s.personsPage('',excluded,0,0,100,'all');
   assert.equal(list.total,2);assert.equal(list.items.length,2);
   const options=s.personOptions('',0,50,true,'',excluded);
   assert.equal(options.total,2);
   const summary=s.summary(sid,excluded,false);
   assert.equal(summary.messages,all?2:1);
   assert.equal(s.followingAnalytics(sid,excluded).newFollowers.length,all?2:1);
   assert.equal(s.followerChanges(at,at+minute,excluded).newFollowers.length,all?2:1);
  }
  s.endSession(sid,at+minute);
  for(const excluded of [false,[]] as (false|string[])[]){
   const all=excluded===false,report=s.analytics({sessionId:sid,fromMs:0,toMs:Date.now(),excludedLogins:excluded});
   assert.deepEqual(report.audience.map(p=>p.name).sort(),all?['suspect','viewer']:['viewer']);
   assert.equal(report.summary.messages,all?2:1);
   assert.equal(report.timeline[0]!.viewers,all?10:9);
   assert.equal(s.sessions(sid,0,100,excluded)[0]!.viewerMean,all?10:9);
   assert.equal(s.channelOverview(excluded).records.peakOnline!.value,all?10:9);
  }
  assert.deepEqual(s.recentEvents().map(e=>e.person_id).sort(),[suspect,people.get('viewer')!].sort());
  const db=(s as unknown as {db:Database.Database}).db;
  assert.equal((db.prepare('SELECT count(*) n FROM events').get() as {n:number}).n,6);
  assert.equal((db.prepare('SELECT twitch_viewers n FROM stream_samples').get() as {n:number}).n,11);
 }finally{s.close();}
});

test('service donations remain stored while audience money totals agree across reports and bot modes',()=>{
 const s=new StreamStore(':memory:'),at=Date.now()-120000;
 try{
  const sid=s.startSession('owner','service-money',at,'platform',at),people=new Map<string,string>();
  for(const user of ['jeetbot','viewer'])people.set(user,s.ingest({source:'twitch',accountId:'owner',externalId:user,type:'chat.message',actor:{externalId:user,displayName:user},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{}}).personId!);
  s.streamSample(sid,at,'game','Game','',11);
  for(const [user,id] of people)s.createDonation({personId:id,amount:user==='viewer'?'20':'10',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Cash'},at);
  s.endSession(sid,at+60000);
  for(const excluded of [false,[]] as (false|string[])[]){
   const report=s.analytics({sessionId:sid,fromMs:0,toMs:Date.now(),excludedLogins:excluded});
   assert.equal(report.donationTiming.count,1);assert.equal(report.donationTiming.totals.RUB,'2000');
   assert.equal(report.categories[0]!.donationTotals.RUB,'2000');
   assert.equal((s.summary(sid,excluded,false).totals as Record<string,string>).RUB,'2000');
  }
  assert.equal(s.eventCount(),4);
 }finally{s.close();}
});

test('a bot observed in the next minute cannot reduce the preceding off-boundary viewer sample',()=>{
 const s=new StreamStore(':memory:'),at=Math.floor((Date.now()-600000)/60000)*60000;
 try{
  const sid=s.startSession('owner','minute-regression',at,'platform',at);
  const person=s.ingest({source:'twitch',accountId:'owner',externalId:'bot-message',type:'chat.message',actor:{externalId:'marked',displayName:'AudienceBot'},occurredAtMs:at+60000,receivedAtMs:at+60000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{}}).personId!;
  s.setPersonBot(person,true,s.personRevision(person));s.streamSample(sid,at+30000,'game','Game','',11);
  s.recordPoll(sid,'owner',{startedAtMs:at+60000,completedAtMs:at+60000,status:'complete',userIds:['marked']});s.endSession(sid,at+120000);
  assert.equal(s.sessions(sid)[0]!.viewerMean,10);
  assert.equal(s.analytics({sessionId:sid,fromMs:0,toMs:Date.now()}).streamComparison[0]!.viewers.twitch.mean,10);
 }finally{s.close();}
});
