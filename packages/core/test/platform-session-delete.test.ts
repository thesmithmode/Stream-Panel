import test from 'node:test';import assert from 'node:assert/strict';import {StreamStore} from '../src/store.js';
test('deleting a logical provider stream hides every member, keeps raw history and cannot be rediscovered',()=>{
 const s=new StreamStore(':memory:');try{
  const at=Date.now()-600000;
  const a=s.observePlatformStream('twitch','owner','a',at,at,null,'First')!;
  s.ingest({source:'twitch',accountId:'owner',externalId:'msg',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at+1000,receivedAtMs:at+1000,timeQuality:'provider',transport:'eventsub',sourceTime:null,payload:{text:'keep'}});
  assert.throws(()=>s.deleteSession(a,at+1000),/SESSION_ACTIVE/);assert.equal(s.sessions().length,1);
  s.endSession(a,at+60000);
  const b=s.observePlatformStream('youtube','primary','b',at+120000,at+120000,null,'Second')!;s.endSession(b,at+180000);
  s.mergeSessions([a,b]);s.deleteSession(b,at+240000);s.deleteSession(a,at+250000);
  assert.equal(s.sessions().length,0);assert.equal(s.eventCount(),1);assert.equal(s.persons().length,1);
  assert.equal(s.observePlatformStream('twitch','owner','a',at,at+260000,null,'First'),null);
  s.unmergeSessions(a);assert.equal(s.sessions().length,0);
  assert.throws(()=>s.deleteSession('missing',at),/SESSION_NOT_FOUND/);
  assert.throws(()=>s.deleteSession(a,NaN),/INVALID_TIMESTAMP/);
 }finally{s.close();}
});
