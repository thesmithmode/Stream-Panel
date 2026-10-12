import test from 'node:test';import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';import {eventKey,type EventInput} from '../src/domain.js';
test('donations are newest first before and after timezone repair, across profile, stream, person and paginated lists',()=>{
 const s=new StreamStore(':memory:'),at=Date.UTC(2026,9,12,18),minute=60000;
 const tip=(n:number):EventInput=>({source:'donationalerts',accountId:'da',externalId:String(n),type:'donation',actor:{externalId:'name:donor',displayName:'Donor'},occurredAtMs:null,receivedAtMs:at+(12-n)*minute,sourceTime:new Date(at+3*3600000+n*minute).toISOString().slice(0,19).replace('T',' '),timeQuality:'unknown',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}});
 try{
 const sid=s.startSession('owner','live',at,'platform',at);s.endSession(sid,at+12*minute);
 for(let n=11;n>=0;n--)s.ingest(tip(n));
 const ids=Array.from({length:12},(_,n)=>eventKey(tip(11-n)));
 assert.deepEqual(s.donations().items.map(x=>x.id),ids,'REST receipt order must not reverse source chronology');
 s.resolveDonationTimes(180);const person=s.donations().items[0]!.personId!;
 assert.deepEqual(s.donations().items.map(x=>x.id),ids);
 assert.deepEqual(s.donations(undefined,0,50,false,sid).items.map(x=>x.id),ids);
 assert.deepEqual(s.donations(person,0,50).items.map(x=>x.id),ids);
 assert.deepEqual(s.donations(person,5,4).items.map(x=>x.id),ids.slice(5,9));
 }finally{s.close();}
});
