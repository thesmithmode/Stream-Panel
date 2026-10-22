import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {StoreClient} from '../src/db.js';import {YouTubeConnection} from '../src/youtube.js';import type {Configuration} from '../src/config.js';
import {openProfileDatabase} from '../../../packages/core/src/profile-db.js';
test('YouTube records fresh totals once a minute live and once per fifteen minutes offline without a statistics failure interrupting streams',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subscriber-cadence-')),db=new StoreClient(join(dir,'db'),'ruslan'),base=Date.UTC(2026,9,22,9);let at=base,live=false,fail=false,countRequests=0;
 const tokens={access:'fixture',refresh:'fixture',userId:'owner',expiresAt:base+3600000,scopes:[]},config={value:{youtube:tokens},save:async()=>{}} as unknown as Configuration;
 const request:typeof fetch=async input=>{const url=new URL(String(input));
  if(url.pathname.endsWith('/channels')){assert.equal(url.searchParams.get('part'),'statistics');countRequests++;return fail?Response.json({error:'unavailable'},{status:503}):Response.json({items:[{id:'owner',statistics:{subscriberCount:String(100+countRequests)}}]});}
  if(url.pathname.endsWith('/liveBroadcasts'))return Response.json({items:live?[{id:'live',snippet:{channelId:'owner',title:'Live'}}]:[]});
  if(url.pathname.endsWith('/videos'))return Response.json({items:[{id:'live',liveStreamingDetails:{actualStartTime:new Date(base).toISOString(),concurrentViewers:'5'}}]});
  if(url.pathname.endsWith('/subscriptions'))return Response.json({items:[]});
  throw new Error('Unexpected request '+url.pathname);
 };
 const connection=new YouTubeConnection(config,db,'https://panel.test/callback','ruslan',request,()=>at);
 try{
  await db.ready;await db.call('youtubeSnapshot','owner','channel',{id:'owner',statistics:{subscriberCount:'100'}},base);await db.call('youtubeSnapshot','owner','report',{},base);
  assert.equal(await connection.collectOnce(),300000);at+=60000;await connection.collectOnce();assert.equal(countRequests,0);
  live=true;assert.equal(await connection.collectOnce(),60000);assert.equal(countRequests,1);
  at+=60000;fail=true;assert.equal(await connection.collectOnce(),60000);assert.equal(countRequests,2);
  const history=await db.call('subscriberHistory',{source:'youtube',account:'owner',from:base-1,to:at+1});assert.equal(history.total,101);assert.equal(history.lastAt,base+60000);assert.equal((await db.call('sessions')).length,1);
  fail=false;live=false;at=base+180000;await connection.collectOnce();assert.equal(countRequests,2);
  at=base+960000;await connection.collectOnce();assert.equal(countRequests,3);assert.equal((await db.call('subscriberHistory',{source:'youtube',account:'owner',from:base-1,to:at+1})).total,103);
 }finally{await connection.stop();await db.stop();await rm(dir,{recursive:true,force:true});}
});

test('YouTube starts legacy subscriber history immediately from a fresh count, then keeps the offline cadence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subscriber-first-')),path=join(dir,'db'),db=new StoreClient(path,'ruslan'),base=Date.UTC(2026,9,22,18);let at=base+120000,requests=0;
 const tokens={access:'fixture',refresh:'fixture',userId:'owner',expiresAt:base+7200000,scopes:[]},config={value:{youtube:tokens},save:async()=>{}} as unknown as Configuration;
 const request:typeof fetch=async input=>{const url=new URL(String(input));if(url.pathname.endsWith('/channels')){requests++;return Response.json({items:[{id:'owner',statistics:{subscriberCount:String(100+requests)}}]});}if(url.pathname.endsWith('/liveBroadcasts')||url.pathname.endsWith('/subscriptions'))return Response.json({items:[]});throw new Error('Unexpected request '+url.pathname);};
 const connection=new YouTubeConnection(config,db,'https://panel.test/callback','ruslan',request,()=>at);
 try{
  await db.ready;await db.call('youtubeSnapshot','owner','channel',{id:'owner',statistics:{subscriberCount:'99'}},base);await db.call('youtubeSnapshot','owner','report',{},base);
  // Simulate metadata saved before v25, when channel snapshots were not history.
  const raw=openProfileDatabase(path,'ruslan');try{raw.prepare('DELETE FROM subscriber_counts').run();}finally{raw.close();}
  assert.equal((await db.call('youtubeData','owner')).subscriberCountAt,null);
  await connection.collectOnce();const first=await db.call('subscriberHistory',{source:'youtube',account:'owner',from:base-1,to:at+1});
  assert.deepEqual(first.counts,[{at,total:101}]);assert.equal(first.change,null);assert.equal(requests,1);
  at+=300000;await connection.collectOnce();assert.equal(requests,1);
  at+=600000;await connection.collectOnce();assert.equal(requests,2);assert.equal((await db.call('youtubeData','owner')).subscriberCountAt,at);
  assert.equal((await db.call('subscriberHistory',{source:'youtube',account:'other',from:base-1,to:at+1})).total,null);
 }finally{await connection.stop();await db.stop();await rm(dir,{recursive:true,force:true});}
});

test('an unavailable first YouTube count stays unknown and retries without interrupting collection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subscriber-unknown-')),path=join(dir,'db'),db=new StoreClient(path,'ruslan'),base=Date.UTC(2026,9,22,18);let at=base+120000,requests=0;
 const tokens={access:'fixture',refresh:'fixture',userId:'owner',expiresAt:base+7200000,scopes:[]},config={value:{youtube:tokens},save:async()=>{}} as unknown as Configuration;
 const request:typeof fetch=async input=>{const url=new URL(String(input));if(url.pathname.endsWith('/channels')){requests++;return requests===1?Response.json({}, {status:503}):Response.json({items:[{id:'owner',statistics:{subscriberCount:'100',hiddenSubscriberCount:true}}]});}if(url.pathname.endsWith('/liveBroadcasts')||url.pathname.endsWith('/subscriptions'))return Response.json({items:[]});throw new Error('Unexpected request '+url.pathname);};
 const connection=new YouTubeConnection(config,db,'https://panel.test/callback','ruslan',request,()=>at);
 try{
  await db.ready;await db.call('youtubeSnapshot','owner','channel',{id:'owner'},base);await db.call('youtubeSnapshot','owner','report',{},base);
  assert.equal(await connection.collectOnce(),300000);assert.equal(requests,1);assert.equal((await db.call('youtubeData','owner')).subscriberCountAt,null);
  at=base+900000;await connection.collectOnce();assert.equal(requests,2);
  at+=300000;await connection.collectOnce();assert.equal(requests,2,'hidden totals do not cause extra statistics polls');
  assert.equal((await db.call('subscriberHistory',{source:'youtube',account:'owner',from:base-1,to:at+1})).total,null);
 }finally{await connection.stop();await db.stop();await rm(dir,{recursive:true,force:true});}
});
