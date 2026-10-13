import test from 'node:test';import assert from 'node:assert/strict';import {StreamStore} from '../src/store.js';
test('opening an old stream reads that stream beyond the latest 100 and compact totals agree with full totals',()=>{
 const store=new StreamStore(':memory:');try{
  const start=1790000000000,first=store.startSession('owner','old',start,'platform',start);
  store.ingest({source:'twitch',accountId:'owner',externalId:'old-message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:start+1000,receivedAtMs:start+1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Old stream'}});
  store.endSession(first,start+60000);
  for(let n=1;n<=101;n++){const at=start+n*120000,id=store.startSession('owner',String(n),at,'platform',at);store.streamSample(id,at,'g','Game','Stream',n);store.endSession(id,at+60000);}
  assert.equal(store.sessions().length,100);assert.ok(!store.sessions().some(row=>row.id===first));assert.equal(store.sessions(first)[0]!.id,first);assert.deepEqual(store.sessions('missing'),[]);
  const full=store.summary(first),compact=store.summary(first,[],false);for(const key of ['messages','donations','totals','events'])assert.deepEqual(compact[key],full[key]);assert.equal(compact.messages,1);assert.equal(store.summary(undefined,[],false).messages,1);
 }finally{store.close();}
});
