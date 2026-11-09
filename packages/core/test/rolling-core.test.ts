import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import type {AnalyticsOptions} from '../src/analytics.js';
const day=86400000,minute=60000;
function ready(s:StreamStore,options:AnalyticsOptions){for(let i=0;i<100;i++){const r=s.analytics(options);if(!r.preparing)return r;}throw Error('not ready');}
test('rolling core ignores lifetime and selected period, requires a sample, respects overrides and expires with the clock',()=>{
 const s=new StreamStore(':memory:'),now=Date.now(),base=Math.floor(now/minute)*minute;
 try{
  for(let i=0;i<15;i++){
   const at=base-(60-i*4)*day,id=s.startSession('owner',String(i),at,'platform',at);
   s.streamSample(id,at,'game','Game','',11);
   const users=['loyal',...(i>=4?['new']:[])];
   s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+10*minute,status:'complete',userIds:users});
   s.endSession(id,at+10*minute);
  }
  for(let i=0;i<20;i++){
   const at=base-(120+i)*day,id=s.startSession('owner','old'+i,at,'platform',at);
   s.streamSample(id,at,'old','Old','',11);s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+10*minute,status:'complete',userIds:['veteran']});s.endSession(id,at+10*minute);
  }
  const opts:AnalyticsOptions={fromMs:0,toMs:now,summaryOnly:true,rollingCore:true,ownerId:'owner'};
  assert.equal(ready(s,{...opts,coreWindowDays:30}).summary.core,0);
  assert.equal(ready(s,{...opts,coreWindowDays:180}).audience.find(p=>p.name==='loyal')!.core,false);
  assert.throws(()=>s.analytics({...opts,coreWindowDays:7}),/INVALID_ANALYTICS_FILTER/);
  const all=ready(s,opts),loyal=all.audience.find(p=>p.name==='loyal')!;
  assert.equal(loyal.core,true);assert.equal(all.audience.find(p=>p.name==='veteran')!.core,false);
  assert.equal(all.audience.find(p=>p.name==='new')!.core,false);
  const recent=ready(s,{...opts,fromMs:now-7*day});assert.equal(recent.audience.find(p=>p.id===loyal.id)!.core,true);
  assert.equal(recent.summary.streams,1);assert.equal(recent.streamComparison[0]!.core,1);
  const session=ready(s,{...opts,sessionId:recent.streamComparison[0]!.id});assert.equal(session.audience.find(p=>p.id===loyal.id)!.core,true);
  s.setPersonMetadata(loyal.id,[],false,s.personRevision(loyal.id));assert.equal(ready(s,opts).audience.find(p=>p.id===loyal.id)!.core,false);
  s.setPersonMetadata(loyal.id,[],true,s.personRevision(loyal.id));assert.equal(ready(s,opts).audience.find(p=>p.id===loyal.id)!.core,true);
  s.setPersonMetadata(loyal.id,[],null,s.personRevision(loyal.id));
  const original=Date.now;try{Date.now=()=>now+100*day;assert.equal(ready(s,{...opts,toMs:Date.now()}).audience.find(p=>p.id===loyal.id)!.core,false);}finally{Date.now=original;}
 }finally{s.close();}
});
test('fewer than twelve streams cannot automatically establish rolling core',()=>{
 const s=new StreamStore(':memory:'),now=Date.now(),at=now-40*day;
 try{const id=s.startSession('owner','single',at,'platform',at);s.streamSample(id,at,'game','Game','',11);s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:['viewer']});s.endSession(id,at+minute);
 assert.equal(ready(s,{fromMs:0,toMs:now,summaryOnly:true,rollingCore:true}).summary.core,0);
 }finally{s.close();}
});
test('rolling membership includes every page, excludes young cohorts, and keeps profile data separate',()=>{
 const s=new StreamStore(':memory:'),other=new StreamStore(':memory:'),now=Date.now(),users=Array.from({length:105},(_,i)=>`viewer-${i}`);
 try{
  for(let i=0;i<12;i++){
   const at=now-(50-i*4)*day,id=s.startSession('owner',String(i),at,'platform',at);s.streamSample(id,at,'game','Game','',11);
   s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:users});s.endSession(id,at+minute);
  }
  const opts:AnalyticsOptions={fromMs:now-10*day,toMs:now,summaryOnly:true,rollingCore:true,audienceOffset:100};
  const r=ready(s,opts);assert.equal(r.summary.core,105);assert.equal(r.audience.length,5);assert.ok(r.audience.every(p=>p.core));assert.equal(ready(other,opts).summary.core,0);
  const original=Date.now;try{Date.now=()=>now-25*day;const young=ready(s,{...opts,fromMs:0,toMs:Date.now()});assert.equal(young.summary.core,0);}finally{Date.now=original;}
 }finally{s.close();other.close();}
});
test('thirty-day core window uses its full sample and preserves manual overrides',()=>{
 const s=new StreamStore(':memory:'),now=Date.now();try{
  for(let i=0;i<12;i++){const at=now-(i+1)*day,id=s.startSession('owner',String(i),at,'platform',at);s.streamSample(id,at,'game','Game','',11);s.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:['viewer']});s.endSession(id,at+minute);}
  const opts:AnalyticsOptions={fromMs:0,toMs:now,rollingCore:true,coreWindowDays:30};const r=ready(s,opts);assert.equal(r.summary.core,1);
  const id=r.audience[0]!.id;s.setPersonMetadata(id,[],true,s.personRevision(id));assert.equal(ready(s,opts).summary.core,1);
 }finally{s.close();}
});
