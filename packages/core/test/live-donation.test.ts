import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
import type {EventInput} from '../src/domain.js';

test('live donation ingestion atomically rejects closed/replaced streams and old facts without corrupting unknown timestamps',()=>{
 const s=new StreamStore(':memory:');const at=Date.UTC(2026,9,1),m=60000;
 const event=(id:string,time:number|null):EventInput=>({source:'donationalerts',accountId:'da',externalId:id,type:'donation',actor:{externalId:'name:viewer',displayName:'Viewer'},occurredAtMs:time,receivedAtMs:at+m,sourceTime:null,timeQuality:time===null?'unknown':'configured',transport:'centrifugo',payload:{amountMinor:'100',currency:'RUB'}});
 try {
  assert.equal(s.ingestLiveDonation(event('offline',at),'missing'),null);
  const id=s.observePlatformStream('youtube','yt','first',at,at,null,'Live')!;
  assert.equal(s.ingestLiveDonation(event('old',at-1),id),null);
  assert.equal(s.ingestLiveDonation({...event('old receipt',at),receivedAtMs:at-1},id),null);
  assert.equal(s.ingestLiveDonation(event('unknown',null),id),null);
  assert.equal(s.ingestLiveDonation(event('unknown',null),id,true)?.inserted,true);
  assert.equal(s.events().find(e=>e.external_id==='unknown')!.occurred_at_ms,null);
  assert.equal(s.ingestLiveDonation(event('now',at),id)?.inserted,true);
  assert.equal(s.ingestLiveDonation(event('now',at),id)?.inserted,false);
  s.platformMissing('youtube','yt',[],at+m);s.platformMissing('youtube','yt',[],at+2*m);
  assert.equal(s.ingestLiveDonation(event('late',at),id),null);
  const next=s.observePlatformStream('youtube','yt','second',at+3*m,at+3*m,null,'Next')!;
  assert.notEqual(next,id);assert.equal(s.ingestLiveDonation(event('replaced',at),id),null);
  assert.throws(()=>s.ingestLiveDonation({...event('bad source',at),source:'twitch'},next),/INVALID_LIVE_DONATION/);
  assert.equal(s.events().length,2);
 }finally{s.close();}
});
