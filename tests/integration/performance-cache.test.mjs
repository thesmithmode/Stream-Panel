import test from 'node:test';
import assert from 'node:assert/strict';
import {application} from '../helpers/application.mjs';
test('wire cache observes mutations, separates stream keys and removes unused poll history',async()=>{
 const a=await application();try{
  const host=new URL(a.origin).host;
  const auth=await a.app.inject({method:'POST',url:'/api/v1/bootstrap',headers:{host,origin:a.origin},payload:{key:a.bootstrap().split('#key=')[1]}});
  const headers={host,cookie:auth.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
  const at=Date.now()-86400000;
  const first=await a.db.call('startSession','owner','one',at,'platform',at);await a.db.call('endSession',first,at+60000);
  const second=await a.db.call('startSession','owner','two',at+120000,'platform',at+120000);await a.db.call('endSession',second,at+180000);
  const url=`/api/v1/followers/changes?from=${at}&to=${at+3600000}`;
  const read=async(url,etag)=>a.app.inject({url,headers:{...headers,...(etag?{'if-none-match':etag}:{})}});
  const empty=await read(url);assert.equal(empty.statusCode,200);assert.equal('polls' in empty.json(),false);
  assert.equal((await read(url,empty.headers.etag)).statusCode,304);
  await a.db.call('followingSnapshot','twitch','owner',[{id:'viewer',name:'Viewer',followedAtMs:at+30000}],true,at+40000,1);
  const changed=await read(url,empty.headers.etag);assert.equal(changed.statusCode,200);assert.equal(changed.json().newFollowers.length,1);assert.equal('polls' in changed.json(),false);
  const stream=await read(`/api/v1/sessions/${first}/followers`),peer=await read(`/api/v1/sessions/${second}/followers`);
  assert.equal(stream.json().newFollowers.length,1);assert.equal(peer.json().newFollowers.length,0);assert.equal('polls' in stream.json(),false);
  const query=new URLSearchParams({session:first,from:'0',to:String(Date.now()),mode:'summary'});
  const report=await read('/api/v1/analytics?'+query);assert.equal(report.statusCode,200);assert.equal((await read('/api/v1/analytics?'+query,report.headers.etag)).statusCode,304);
  await a.db.call('ingest',{source:'twitch',accountId:'owner',externalId:'late',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at+10000,receivedAtMs:Date.now(),sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'late correction'}});
  const corrected=await read('/api/v1/analytics?'+query,report.headers.etag);assert.equal(corrected.statusCode,200);assert.notEqual(corrected.headers.etag,report.headers.etag);assert.equal(corrected.json().summary.messages,1);
  const full=corrected.json();query.set('view','stream');const projected=await read('/api/v1/analytics?'+query);
  assert.deepEqual(Object.keys(projected.json()).sort(),['filters','summary','timeline','audience','streamComparison'].sort());
  for(const field of ['summary','timeline','audience','streamComparison'])assert.deepEqual(projected.json()[field],full[field]);
  assert.ok(Buffer.byteLength(projected.body)<Buffer.byteLength(corrected.body));
  const liveAt=Date.now()-600000,live=await a.db.call('startSession','owner','synthetic-live',liveAt,'platform',liveAt);
  query.set('session',live);const before=await read('/api/v1/analytics?'+query);
  await a.db.call('ingest',{source:'twitch',accountId:'owner',externalId:'live-message',type:'chat.message',actor:{externalId:'live-viewer',displayName:'Live Viewer'},occurredAtMs:liveAt+10000,receivedAtMs:Date.now(),sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'synthetic live input'}});
  const fresh=await read('/api/v1/analytics?'+query,before.headers.etag);assert.equal(fresh.statusCode,200);assert.equal(fresh.json().summary.messages,1);

 }finally{await a.close();}
});
