import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {daDonorExternalId,eventKey} from '../src/domain.js';
const at=Date.UTC(2026,9,9,12);
function tip(id:string,name='Аноним') {return {source:'donationalerts' as const,accountId:'da',externalId:id,type:'donation',actor:{externalId:daDonorExternalId(name),displayName:name},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider' as const,transport:'rest' as const,payload:{amountMinor:'10000',currency:'RUB',text:'Original',actorName:name}};}

test('manual donation CRUD uses exact money, revisions and durable tombstones without changing raw provider events',()=>{
 const s=new StreamStore(':memory:');try{
  const person=s.ingest(tip('provider','Viewer')).personId!;
  const created=s.createDonation({personId:person,amount:'123.45',currency:'RUB',occurredAtMs:at,message:'Manual',sourceName:'Cash'},at);
  assert.equal(created.amountMinor,'12345');assert.equal(s.personStats(person).donationTotals && (s.personStats(person).donationTotals as any).RUB,'22345');
  const updated=s.updateDonation(String(created.id),{personId:person,amount:'0.50',currency:'USD',occurredAtMs:at+1000,message:'Corrected',sourceName:'Transfer'},Number(created.revision),at+2000);
  assert.equal(updated.revision,1);assert.equal(updated.amountMinor,'50');
  assert.throws(()=>s.updateDonation(String(created.id),{personId:person,amount:'1',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Manual'},0,at+3000),/DONATION_CONFLICT/);
  s.deleteDonation(String(created.id),1,at+4000);assert.equal((s.personStats(person).donationTotals as any).USD,undefined);
  assert.equal(s.donationAudit(String(created.id)).length,3);
  assert.equal(s.eventCount(),2);assert.equal(s.donation(String(created.id)).deleted,true);
 }finally{s.close();}
});

test('reassigning one anonymous donation preserves the original donor and all other anonymous donations',()=>{
 const s=new StreamStore(':memory:');try{
  const first=tip('one'),second=tip('two'),anon=s.ingest(first).personId!;s.ingest(second);
  const target=s.ingest(tip('target','Actual person')).personId!,id=eventKey(first);
  s.updateDonation(id,{personId:target,amount:'100',currency:'RUB',occurredAtMs:at,message:'Known donor',sourceName:'DonationAlerts'},0,at+1000);
  assert.equal(s.personStats(anon).donationCount,1);assert.equal(s.personStats(target).donationCount,2);
  assert.equal(s.donation(id).originalActorName,'Аноним');
  assert.equal(s.ingest(first).inserted,false);assert.equal(s.personStats(target).donationCount,2);
  s.deleteDonation(id,1,at+2000);assert.equal(s.ingest(first).inserted,false);assert.equal(s.personStats(target).donationCount,1);
  assert.equal(s.eventCount(),3);assert.equal(s.donationAudit(id).length,2);
 }finally{s.close();}
});

test('provider anonymous donations form a separate Person and cannot automatically link to a same-name Twitch account',()=>{
 const s=new StreamStore(':memory:');try{
  const tw=s.ingest({source:'twitch',accountId:'channel',externalId:'message',type:'chat.message',actor:{externalId:'anon-viewer',displayName:'Аноним'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Viewer'}}).personId!;
  const unnamed={...tip('unnamed'),actor:null,payload:{amountMinor:'100',currency:'RUB',actorName:''}};s.ingest(unnamed);
  const anon=s.persons().find(p=>p.display_name==='Аноним'&&p.id!==tw)!;assert.ok(anon);
  assert.equal(s.personStats(String(anon.id)).donationCount,1);assert.equal(s.personStats(tw).donationCount,0);
  const named=s.ingest(tip('label','Аноним')).personId!;assert.notEqual(named,tw);assert.equal(named,anon.id);
  assert.equal(s.donations(String(anon.id)).total,2);
  assert.equal(s.personStats(String(anon.id)).watchingSinceMs,null);
 }finally{s.close();}
});

test('donation mutations reject invalid money, dates, people, stale revisions and page bounds atomically',()=>{
 const s=new StreamStore(':memory:');try{
  const person=s.ingest(tip('provider','Viewer')).personId!,valid={personId:person,amount:'1.00',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Manual'};
  for(const input of [{...valid,amount:'1e3'},{...valid,amount:'-1'},{...valid,amount:'01'},{...valid,currency:'XXX'},{...valid,sourceName:' '},{...valid,personId:'missing'},{...valid,occurredAtMs:NaN},{...valid,occurredAtMs:null}])assert.throws(()=>s.createDonation(input,at));
  assert.equal(s.eventCount(),1);
  assert.throws(()=>s.updateDonation('missing',valid,0,at),/DONATION_NOT_FOUND/);
  assert.throws(()=>s.deleteDonation(eventKey(tip('provider','Viewer')),-1,at),/INVALID_DONATION_REVISION/);
  for(const [offset,limit] of [[-1,10],[.5,10],[0,0],[0,101],[0,NaN]])assert.throws(()=>s.donations(undefined,offset,limit),/INVALID_DONATION_PAGE/);
  const item=s.createDonation({...valid,amount:'10000000000000000000.99'},at);assert.equal(item.amountMinor,'1000000000000000000099');
  const updated=s.updateDonation(String(item.id),{...valid,occurredAtMs:null},0,at+1);assert.equal(updated.occurredAtMs,null);
  s.deleteDonation(String(item.id),1,at+2);assert.equal(s.donations(person).total,1);assert.equal(s.donations(person,0,50,true).total,2);
  assert.throws(()=>s.updateDonation(String(item.id),valid,2,at+3),/INVALID_DELETED_DONATION/);
  assert.throws(()=>s.deleteDonation(String(item.id),2,at+3),/INVALID_DELETED_DONATION/);
 }finally{s.close();}
});

test('deleted donations restore with a new revision and full audit rather than recreating a provider event',()=>{
 const s=new StreamStore(':memory:');try{
  const event=tip('restore','Viewer'),person=s.ingest(event).personId!,id=eventKey(event);
  assert.throws(()=>s.restoreDonation(id,0,at),/INVALID_ACTIVE_DONATION/);
  s.deleteDonation(id,0,at+1);assert.equal(s.events(undefined,person).length,0);
  assert.throws(()=>s.restoreDonation(id,0,at+2),/DONATION_CONFLICT/);
  const restored=s.restoreDonation(id,1,at+2);assert.equal(restored.deleted,false);assert.equal(restored.revision,2);
  assert.equal(s.personStats(person).donationCount,1);assert.equal(s.eventCount(),1);
  assert.deepEqual(s.donationAudit(id).map(row=>row.kind),['restore','delete']);
 }finally{s.close();}
});


test('corrections preserve raw SQLite bytes, provenance and independent profiles across restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-donation-corrections-')),path=join(dir,'data.sqlite');
 try{
  let a=new StreamStore(path,'ruslan'),b=new StreamStore(path,'gulnaz');const event=tip('same','Original donor'),id=eventKey(event);
  const original=a.ingest(event).personId!,other=b.ingest(event).personId!;
  const input={personId:original,amount:'7.00',currency:'USD',occurredAtMs:at+1000,message:'Updated',sourceName:'DA correction'};
  a.updateDonation(id,input,0,at+2000);a.deleteDonation(id,1,at+3000);a.close();b.close();
  const raw=new Database(path,{readonly:true});
  try{
   for(const profile of ['ruslan','gulnaz']){
    const row=raw.prepare(`SELECT payload_json,occurred_at_ms FROM p_${profile}_events WHERE id=?`).get(id) as {payload_json:string;occurred_at_ms:number};
    assert.deepEqual(JSON.parse(row.payload_json),event.payload);assert.equal(row.occurred_at_ms,at);
   }
   assert.equal(raw.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(raw.pragma('foreign_key_check'),[]);
  }finally{raw.close();}
  a=new StreamStore(path,'ruslan');b=new StreamStore(path,'gulnaz');
  try{
   assert.equal(a.donation(id).deleted,true);assert.equal(a.donationAudit(id).length,2);assert.equal(a.ingest(event).inserted,false);
   assert.equal(a.personStats(original).donationCount,0);assert.equal(b.personStats(other).donationCount,1);
   a.restoreDonation(id,2,at+4000);assert.equal((a.personStats(original).donationTotals as any).USD,'700');
   assert.equal((b.personStats(other).donationTotals as any).RUB,'10000');
  }finally{a.close();b.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('explicit Person creation stays visible without fabricated identities or attendance and can receive manual donations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-person-create-')),path=join(dir,'db.sqlite');
 const s=new StreamStore(path,'ruslan');let id='';try{
  const p=s.createPerson('  New person  ');id=String(p.id);assert.equal(p.display_name,'New person');assert.deepEqual(p.identities,[]);
  assert.ok(s.persons().some(p=>p.id===id));assert.equal(s.personStats(id).watchingSinceMs,null);assert.equal(s.personStats(id).sessionsWithAttendance,0);
  assert.equal(s.personMetadata(id).manualCore,null);assert.equal(s.personNotes(id).length,0);
  s.createDonation({personId:id,amount:'10',currency:'RUB',occurredAtMs:at,message:'Offline support',sourceName:'Cash'},at);
  assert.equal(s.personStats(id).donationCount,1);assert.equal(s.personStats(id).watchingSinceMs,null);
  assert.notEqual(s.createPerson('New person').id,id);for(const name of ['', '  ', 'a'.repeat(201)])assert.throws(()=>s.createPerson(name),/INVALID_NAME/);
 }finally{s.close();}
 const again=new StreamStore(path,'ruslan'),other=new StreamStore(path,'gulnaz');try{assert.ok(again.persons().some(p=>p.id===id));assert.equal(other.persons().length,0);assert.throws(()=>other.person(id),/PERSON_NOT_FOUND/);}finally{again.close();other.close();await rm(dir,{recursive:true,force:true});}
});

test('repeated corrections move only one donation and invalidate Person membership guards only when assignment changes',()=>{
 const s=new StreamStore(':memory:');try{
  const event=tip('single'),id=eventKey(event),anon=s.ingest(event).personId!;s.ingest(tip('untouched'));
  const first=String(s.createPerson('First').id),second=String(s.createPerson('Second').id);
  const input={personId:first,amount:'100',currency:'RUB',occurredAtMs:at,message:'',sourceName:'DonationAlerts'};
  s.updateDonation(id,input,0,at+1);const revision=s.personRevision(first);
  s.updateDonation(id,{...input,amount:'101'},1,at+2);assert.equal(s.personRevision(first),revision);
  const secondRevision=s.personRevision(second);s.updateDonation(id,{...input,personId:second},2,at+3);
  assert.equal(s.personRevision(first),revision+1);assert.equal(s.personRevision(second),secondRevision+1);
  assert.equal(s.personStats(first).donationCount,0);assert.equal(s.personStats(second).donationCount,1);assert.equal(s.personStats(anon).donationCount,1);
  assert.equal((s.person(second).identities as any[]).length,1);assert.equal(s.donation(id).originalActorName,'Аноним');assert.equal(s.donationAudit(id).length,3);
  assert.equal(s.donations().total,2);assert.equal(s.donations(undefined,1,1).items.length,1);
 }finally{s.close();}
});

test('editing donation time moves its stream attribution, and unknown time removes attribution without losing history',()=>{
 const s=new StreamStore(':memory:');try{
  const first=s.observePlatformStream('youtube','channel','one',at,at,null,'First')!;s.endSession(first,at+5*60000);
  const second=s.observePlatformStream('youtube','channel','two',at+10*60000,at+10*60000,null,'Second')!;s.endSession(second,at+15*60000);
  const person=String(s.createPerson('Offline donor').id),input={personId:person,amount:'1',currency:'RUB',occurredAtMs:at+60000,message:'',sourceName:'Cash'};
  const donation=s.createDonation(input,at+20*60000);assert.equal(s.summary(first).donations,1);assert.equal(s.summary(second).donations,0);
  s.updateDonation(donation.id,{...input,occurredAtMs:at+11*60000},0,at+21*60000);assert.equal(s.summary(first).donations,0);assert.equal(s.summary(second).donations,1);
  s.deleteDonation(donation.id,1,at+22*60000);assert.equal(s.summary(second).donations,0);s.restoreDonation(donation.id,2,at+23*60000);assert.equal(s.summary(second).donations,1);
  s.updateDonation(donation.id,{...input,occurredAtMs:null},3,at+24*60000);assert.equal(s.summary(second).donations,0);assert.equal(s.summary().donations,1);assert.equal(s.personStats(person).watchingSinceMs,null);
 }finally{s.close();}
});

test('legacy donations with missing optional fields retain unknown amounts, currencies, messages and timestamps',()=>{
 const s=new StreamStore(':memory:');try{
  for(const account of ['da','manual']){
   const event={...tip(`legacy-${account}`),accountId:account,actor:null,occurredAtMs:null,timeQuality:'unknown' as const,payload:{}};s.ingest(event);
   const item=s.donation(eventKey(event));assert.equal(item.amountMinor,'');assert.equal(item.currency,'');assert.equal(item.message,'');assert.equal(item.originalActorName,'');assert.equal(item.occurredAtMs,null);
   assert.equal(item.sourceName,account==='manual'?'Manual':'DonationAlerts');
  }
  assert.equal(s.donations().total,2);assert.equal(s.summary().donations,2);assert.deepEqual(s.summary().totals,{});
 }finally{s.close();}
});
