import test from 'node:test';import assert from 'node:assert/strict';import {StoreClient} from '../src/db.js';
test('status and collector reads preserve valid cached analytics while mutations invalidate it',async()=>{
 const db=new StoreClient(':memory:');const internals=db as unknown as {cache:{version:number}};
 try{
  await db.call('channelOverview');const before=internals.cache.version;
  await db.call('gaps');await db.call('activeLogicalStream');await db.call('youtubeData','owner');assert.equal(internals.cache.version,before);
  await db.call('collectionLifecycle','start',Date.now());
  const operational=internals.cache.version;
  await db.call('collectionLifecycle','heartbeat',Date.now());
  await db.call('youtubeQuota','10/15/2026','ruslan');
  await db.call('warmAnalytics',{fromMs:0,toMs:Date.now()});
  await db.call('youtubeMessages','owner','chat',[]);
  await db.call('youtubeSnapshot','owner','cursor:chat','next-page',Date.now());
  assert.equal((await db.call('youtubeData','owner')).snapshots['cursor:chat']!.data,'next-page');
  assert.equal(internals.cache.version,operational,'maintenance must not discard ready reports');
  await db.call('youtubeSnapshot','owner','report',{rows:[[5]]},Date.now());
  assert.ok(internals.cache.version>operational,'actual report changes must invalidate cached responses');
  const reportRevision=internals.cache.version;
  await db.call('youtubeMessages','owner','chat',[{id:'message',snippet:{type:'textMessageEvent',publishedAt:new Date().toISOString(),displayMessage:'Real message'},authorDetails:{channelId:'viewer',displayName:'Viewer'}}]);
  assert.ok(internals.cache.version>reportRevision,'real messages must invalidate cached metrics');
  await db.call('createPerson','New');assert.ok(internals.cache.version>before);
 }finally{await db.stop();}
});
