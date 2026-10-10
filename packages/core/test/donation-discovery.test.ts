import test from 'node:test';import assert from 'node:assert/strict';import {StreamStore} from '../src/store.js';
test('donations fetched before live discovery attach by provider time without fabricating chat coverage or reassigning manual facts',()=>{
 const s=new StreamStore(':memory:');try{
  const donation=(id:string,at:number|null)=>s.ingest({source:'donationalerts',accountId:'recipient',externalId:id,type:'donation',actor:null,occurredAtMs:at,receivedAtMs:3000,sourceTime:null,timeQuality:at===null?'unknown':'configured',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}});
  donation('older',900);donation('within',1100);donation('unknown',null);
  const id=s.observePlatformStream('twitch','owner','one',1000,2000,null,'Stream')!;
  assert.deepEqual(s.events(id).map(e=>e.external_id),['within']);assert.equal(s.summary(id).donations,1);
  assert.equal((s.summary(id).coverage as any).knownMinutes,0);assert.equal(s.summary(id).messages,0);
  s.endSession(id,2500);donation('late-import',2200);assert.equal(s.summary(id).donations,2);
  assert.equal(s.summary().donations,4);
 }finally{s.close();}
});
