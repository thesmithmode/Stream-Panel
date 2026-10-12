import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {parseDonationTime} from '../src/donation-time.js';
import {eventKey,type EventInput} from '../src/domain.js';
const at=Date.UTC(2026,9,12,18),minute=60000;
const tip=(id:string,sourceTime='2026-10-12 18:01:00'):EventInput=>({source:'donationalerts',accountId:'da',externalId:id,type:'donation',actor:{externalId:'name:donor',displayName:'Donor'},occurredAtMs:null,receivedAtMs:at+minute,sourceTime,timeQuality:'unknown',transport:'rest',payload:{actorName:'Donor',amountMinor:'10000',currency:'RUB'}});
test('timezone repair distributes imported tips across closed streams, preserves a chosen viewer and explicit edits, and is idempotent',()=>{
 const s=new StreamStore(':memory:');try{
 const earlier=s.startSession('owner','early',at-3*3600000,'platform',at-3*3600000);s.endSession(earlier,at-2*3600000);
 const sid=s.startSession('owner','late',at,'platform',at);s.endSession(sid,at+10*minute);
 for(const id of ['normal','assigned','edited','deleted'])s.ingest(tip(id));s.ingest(tip('invalid','broken'));s.ingest({...tip('no-source'),sourceTime:null});
 const viewer=String(s.createPerson('Chosen viewer').id);
 s.reassignDonation(eventKey(tip('assigned')),viewer,0,at);
 s.updateDonation(eventKey(tip('edited')),{personId:viewer,amount:'500',currency:'RUB',message:'explicit edit',sourceName:'DA',occurredAtMs:null},0,at);
 s.deleteDonation(eventKey(tip('deleted')),0,at);
 assert.equal(s.summary(sid).donations,0);
 assert.deepEqual(s.resolveDonationTimes(0),{resolved:4,invalid:1});
 assert.equal(s.summary(sid).donations,2);assert.equal((s.summary(sid).totals as Record<string,string>).RUB,'20000');
 assert.equal(s.donation(eventKey(tip('assigned'))).personId,viewer);
 assert.equal(s.donation(eventKey(tip('edited'))).occurredAtMs,null);
 assert.equal(s.donation(eventKey(tip('invalid'))).occurredAtMs,null);
 assert.deepEqual(s.resolveDonationTimes(0),{resolved:0,invalid:1});
 assert.deepEqual(s.resolveDonationTimes(180),{resolved:4,invalid:1});
 assert.equal(s.summary(sid).donations,0);assert.equal(s.summary(earlier).donations,2);
 assert.throws(()=>s.resolveDonationTimes(900),/INVALID_UTC_OFFSET/);
 assert.throws(()=>s.resolveDonationTimes(1.5),/INVALID_UTC_OFFSET/);
 const page=s.donations();assert.equal(page.items.find(d=>d.providerId==='assigned')?.sourceTime,'2026-10-12 18:01:00');assert.deepEqual(page.items.find(d=>d.providerId==='assigned')?.sessionIds,[earlier]);
 }finally{s.close();}
});
test('explicit ISO DA timestamps work without an offset; unknown legacy dates are never guessed',()=>{
 assert.equal(parseDonationTime('2026-10-12T18:01:00Z',null),at+minute);
 assert.equal(parseDonationTime('2026-10-12T21:01:00+03:00',180),at+minute);
 assert.equal(parseDonationTime('2026-10-12 18:01:00',null),null);
 assert.equal(parseDonationTime('2026-10-12 21:01:00',180),at+minute);
 assert.throws(()=>parseDonationTime('2026-02-30 12:00:00',0),/INVALID_DA_DATE/);
 assert.throws(()=>parseDonationTime('malformed',0),/INVALID_DA_TIME/);
 assert.throws(()=>parseDonationTime('2026-10-12T99:00:00Z',null),/INVALID_DA_DATE/);
 assert.throws(()=>parseDonationTime('2026-10-12T18:00:00Z',1000),/INVALID_UTC_OFFSET/);
});
test('repair stays within the selected profile in a shared database',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'sp-tip-time-'));
 const a=new StreamStore(join(dir,'shared.sqlite'),'ruslan'),b=new StreamStore(join(dir,'shared.sqlite'),'gulnaz');
 try{a.ingest(tip('same'));b.ingest(tip('same'));a.resolveDonationTimes(0);assert.equal(a.donation(eventKey(tip('same'))).occurredAtMs,at+minute);assert.equal(b.donation(eventKey(tip('same'))).occurredAtMs,null);}
 finally{a.close();b.close();await rm(dir,{recursive:true,force:true});}
});
