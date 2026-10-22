import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {StoreClient} from '../src/db.js';import {YouTubeConnection} from '../src/youtube.js';import type {Configuration} from '../src/config.js';
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
