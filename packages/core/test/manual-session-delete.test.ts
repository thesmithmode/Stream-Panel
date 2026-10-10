import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const at=Date.UTC(2026,9,9,12),minute=60000;
const input=(id:string,time:number)=>({source:'twitch' as const,accountId:'channel',externalId:id,type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:time,receivedAtMs:time,sourceTime:null,timeQuality:'provider' as const,transport:'eventsub' as const,payload:{text:'Real message'}});

test('deleting a manual stream hides only the recording and preserves raw events, people and observation records',()=>{
 const s=new StreamStore(':memory:');try{
  const manual=s.startSession('local','mistake',at,'manual',at),event=s.ingest(input('message',at+minute));
  s.recordPoll(manual,'channel',{startedAtMs:at,completedAtMs:at+minute,status:'complete',userIds:['viewer']});
  assert.equal(s.events(manual).length,1);s.deleteManualSession(manual,at+2*minute);
  assert.equal(s.sessions().length,0);assert.equal(s.events(manual).length,0);
  assert.equal(s.eventCount(),1);assert.equal(s.events(undefined,event.personId!).length,1);
  assert.equal(s.persons().length,1);assert.equal(s.personStats(event.personId!).lastObservedMs,at+minute);
  s.deleteManualSession(manual,at+3*minute);assert.equal(s.eventCount(),1);
  s.ingest(input('after',at+minute));assert.equal(s.events(manual).length,0);
 }finally{s.close();}
});

test('manual deletion reassigns real events only to a confirmed matching platform interval',()=>{
 const s=new StreamStore(':memory:');try{
  const manual=s.startSession('local','mistake',at,'manual',at);s.ingest(input('message',at+minute));
  const real=s.observePlatformStream('twitch','channel','real',at,at+2*minute,null,'Actual stream')!;
  assert.equal(s.events(real).length,0);s.deleteManualSession(manual,at+3*minute);
  assert.equal(s.events(real).length,1);assert.equal(s.eventCount(),1);
  assert.equal(s.sessions().length,1);assert.equal(s.sessions()[0]!.id,real);
  assert.throws(()=>s.deleteManualSession(real,at+4*minute),/PLATFORM_SESSION_MANAGED_AUTOMATICALLY/);
  assert.throws(()=>s.deleteManualSession('missing',at),/SESSION_NOT_FOUND/);
  assert.throws(()=>s.deleteManualSession(manual,NaN),/INVALID_TIMESTAMP/);
 }finally{s.close();}
});

test('manual deletion tombstones persist and isolate identical IDs between profiles',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-manual-delete-')),path=join(dir,'data.sqlite');
 try{
  let a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');
  const x=a.startSession('local','mistake',at,'manual',at),y=b.startSession('local','mistake',at,'manual',at);
  a.ingest(input('same',at+minute));b.ingest(input('same',at+minute));a.deleteManualSession(x,at+2*minute);a.close();b.close();
  a=new StreamStore(path,'ruslan');b=new StreamStore(path,'gulnaz');
  try{assert.equal(a.sessions().length,0);assert.equal(a.eventCount(),1);assert.equal(b.sessions()[0]!.id,y);assert.equal(b.events(y).length,1);}finally{a.close();b.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
