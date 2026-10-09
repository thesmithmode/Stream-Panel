import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';

const event=(id:string,at=1000)=>({source:'twitch' as const,accountId:'channel',externalId:id,type:'chat.message',actor:{externalId:id,displayName:id},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider' as const,transport:'eventsub' as const,payload:{text:'hello'}});
test('tags and manual core validate atomically, persist and reject stale edits across isolated profiles',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-metadata-')),path=join(dir,'db.sqlite');let a=new StreamStore(path,'ruslan');const b=new StreamStore(path,'gulnaz');
 try {
  const id=a.ingest(event('viewer')).personId!,other=b.ingest(event('viewer')).personId!;
  const before:any=a.personMetadata(id);
  assert.deepEqual(before.tags,[]);assert.equal(before.manualCore,null);
  const changed:any=a.setPersonMetadata(id,[' Friend ','Friend','постоянный'],true,before.revision);
  assert.deepEqual(changed.tags,['Friend','постоянный']);assert.equal(changed.manualCore,true);
  assert.deepEqual((b.personMetadata(other) as any).tags,[]);
  assert.throws(()=>a.setPersonMetadata(id,['lost'],false,before.revision),/REVISION_CONFLICT/);
  for(const tags of [[''],['a'.repeat(65)],Array.from({length:51},(_,n)=>String(n))])assert.throws(()=>a.setPersonMetadata(id,tags,false,changed.revision),/INVALID_PERSON_TAGS/);
  assert.throws(()=>a.setPersonMetadata(id,[],1 as any,changed.revision),/INVALID_MANUAL_CORE/);
  assert.equal((a.personMetadata(id) as any).manualCore,true);
  a.close();a=new StreamStore(path,'ruslan');
  assert.equal((a.personMetadata(id) as any).manualCore,true);
  const reset:any=a.setPersonMetadata(id,[],null,changed.revision);assert.deepEqual(reset.tags,[]);assert.equal(reset.manualCore,null);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('merge displays source tags without moving their origin and undo retains them',()=>{
 const store=new StreamStore(':memory:');try{
  const a=store.ingest(event('a')).personId!,b=store.ingest(event('b')).personId!;
  store.setPersonMetadata(a,['source tag'],true,store.personRevision(a));
  const m=store.merge(a,b,store.personRevision(a),store.personRevision(b),2000);
  assert.deepEqual((store.personMetadata(b) as any).tags,['source tag']);
  assert.equal((store.personMetadata(b) as any).manualCore,null);
  store.undoMerge(m,3000);
  assert.deepEqual((store.personMetadata(a) as any).tags,['source tag']);assert.deepEqual((store.personMetadata(b) as any).tags,[]);
 }finally{store.close();}
});

test('one core classification drives minute stacks, categories and stream comparison with manual include and exclude',()=>{
 const s=new StreamStore(':memory:');const at=Date.UTC(2026,9,1),m=60000;
 try {
  const sid=s.startSession('channel','stream',at,'platform',at);s.streamSample(sid,at,'game','Game','',10);
  const id=s.ingest(event('viewer',at)).personId!;
  s.recordPoll(sid,'channel',{startedAtMs:at,completedAtMs:at+m,status:'complete',userIds:['viewer']});s.endSession(sid,at+2*m);
  const query={fromMs:at,toMs:at+2*m,minSessions:2,minMinutes:30,minMessages:5};
  assert.equal(s.analytics(query).summary.core,0);
  s.setPersonMetadata(id,['Friend'],true,s.personRevision(id));
  const included=s.analytics(query),row=included.audience[0]!;
  assert.equal(row.core,true);assert.equal(row.regular,true);assert.deepEqual(row.tags,['Friend']);
  assert.equal(included.summary.core,included.summary.regulars);assert.equal(included.categories[0]!.core,1);assert.equal(included.streamComparison[0]!.core,1);assert.equal(included.timeline[0]!.regularObserved,1);assert.equal(included.timeline[0]!.regularMessages,1);
  s.setPersonMetadata(id,[],false,s.personRevision(id));
  const excluded=s.analytics({...query,minSessions:1,minMinutes:0,minMessages:0});assert.equal(excluded.summary.core,0);assert.equal(excluded.timeline[0]!.regularObserved,0);
  s.setPersonMetadata(id,[],null,s.personRevision(id));assert.equal(s.analytics({...query,minSessions:1,minMinutes:0,minMessages:0}).summary.core,1);
 }finally{s.close();}
});

test('manual core cannot resurrect a bot and donation-only supporters do not acquire attendance',()=>{
 const s=new StreamStore(':memory:');const at=Date.UTC(2026,9,1),m=60000;
 try {
  const sid=s.startSession('channel','stream',at,'platform',at);s.streamSample(sid,at,'game','Game','',10);
  const bot=s.ingest({...event('bot',at),actor:{externalId:'bot',displayName:'StreamElements'}}).personId!;
  const donor=s.ingest({...event('donor',at),source:'donationalerts',type:'donation',actor:{externalId:'name:donor',displayName:'Donor'},payload:{amountMinor:'100',currency:'RUB'}}).personId!;
  s.setPersonMetadata(bot,[],true,s.personRevision(bot));s.setPersonMetadata(donor,['Supporter'],true,s.personRevision(donor));s.endSession(sid,at+2*m);
  const report=s.analytics({fromMs:at,toMs:at+2*m});
  assert.equal(report.audience.some(p=>p.id===bot),false);
  const row=report.audience.find(p=>p.id===donor)!;
  assert.equal(row.core,true);assert.equal(row.attendanceRatio,0);assert.deepEqual(row.attendanceSessionIds,[]);
  assert.equal(report.summary.core,1);assert.equal(report.summary.regularShare,1);
  assert.equal(report.timeline[0]!.regularObserved,0);assert.equal(report.timeline[0]!.regularMessages,0);
 }finally{s.close();}
});
