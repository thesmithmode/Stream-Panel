import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import {daDonorExternalId} from '../src/domain.js';
import {repairConfirmedPerson,confirmedPerson} from '../src/confirmed-person-repair.js';
// Synthetic names: the real confirmed pair is deployment data (STREAM_PANEL_CONFIRMED_PERSON).
const spec={viewer:'viewer4207',donors:['Ivan4ik','Иван4ик']};
function event(store:StreamStore,source:'twitch'|'donationalerts',name:string){store.ingest({source,accountId:'owner',externalId:name,type:source==='twitch'?'chat.message':'donation',actor:{externalId:source==='twitch'?'123':daDonorExternalId(name),displayName:name},occurredAtMs:1000,receivedAtMs:1000,sourceTime:null,timeQuality:'provider',transport:source==='twitch'?'eventsub':'rest',payload:source==='twitch'?{text:'hello'}:{currency:'RUB',amountMinor:'100'}});}
test('owner-confirmed donor repair is narrow, idempotent, reversible and preserves money',()=>{
 const store=new StreamStore(':memory:');try{
  assert.equal(repairConfirmedPerson(store,spec).state,'not-found');
  event(store,'twitch','viewer4207');event(store,'donationalerts','Ivan4ik');
  const before=store.summary();assert.equal(store.persons().length,2);
  const result=repairConfirmedPerson(store,spec);assert.equal(result.state,'merged');assert.equal(store.persons().length,1);assert.deepEqual(store.summary().totals,before.totals);
  assert.equal(repairConfirmedPerson(store,spec).state,'already-linked-or-absent');
  if(result.state==='merged')store.undoMerge(result.mergeId,Date.now());assert.equal(store.persons().length,2);
 }finally{store.close();}
});
test('repair never joins a conflicting Twitch account on nickname similarity alone',()=>{
 const store=new StreamStore(':memory:');try{
  event(store,'twitch','viewer4207');store.ingest({source:'twitch',accountId:'owner',externalId:'other',type:'chat.message',actor:{externalId:'999',displayName:'Ivan4ik'},occurredAtMs:2000,receivedAtMs:2000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
  assert.equal(repairConfirmedPerson(store,spec).state,'already-linked-or-absent');assert.equal(store.persons().length,2);
 }finally{store.close();}
});
test('the confirmed names are read from deployment configuration and validated',()=>{
 assert.equal(confirmedPerson(undefined),null);assert.equal(confirmedPerson('  '),null);
 assert.deepEqual(confirmedPerson(JSON.stringify(spec)),spec);
 for(const raw of ['not json','null','[]','{"viewer":"","donors":["a"]}','{"viewer":"v","donors":[]}','{"viewer":"v","donors":[1]}','{"viewer":"v"}',JSON.stringify({viewer:'v',donors:Array(9).fill('d')}),JSON.stringify({viewer:'x'.repeat(129),donors:['d']})])
  assert.throws(()=>confirmedPerson(raw),/INVALID_CONFIRMED_PERSON/,raw);
});
