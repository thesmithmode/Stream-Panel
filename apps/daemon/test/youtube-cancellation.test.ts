import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Configuration} from '../src/config.js';
import type {StoreClient} from '../src/db.js';
import {YouTubeConnection} from '../src/youtube.js';

for(const target of ['snapshot:channel','snapshot:broadcasts','snapshot:liveVideoDetails','observePlatformStream','youtubeViewers','unknown-viewers','platformMissing','youtubeMessages','snapshot:cursor:chat','snapshot:report','request:report']) {
 test(`YouTube cancellation after ${target} stops later mutations and cannot restore connected status`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sp-yt-cancel-')),config=new Configuration(dir);await config.load();
  const now=Date.UTC(2026,9,1,12);config.value.youtube={userId:'owner',access:'fixture',refresh:'fixture',expiresAt:now+3600000,scopes:[]};
  let connection:YouTubeConnection,stopped=false,hit=false;const after:string[]=[];
  const stop=async(key:string)=>{if(key===target){hit=true;await connection.stop();stopped=true;}};
  const db={call:async(method:string,...args:any[])=>{
   const key=method==='youtubeSnapshot'?`snapshot:${args[1]}`:method==='youtubeViewers'&&target==='unknown-viewers'?'unknown-viewers':method;
   if(stopped)after.push(key);await stop(key);
   if(method==='youtubeData')return {snapshots:{},messages:[]};
   if(method==='youtubeQuota')return true;
   if(method==='observePlatformStream')return 'logical';
   return null;
  }} as unknown as StoreClient;
  const request:typeof fetch=async input=>{
   const url=new URL(String(input));
   if(stopped)after.push(`request:${url.pathname}`);
   if(url.pathname.endsWith('/channels'))return Response.json({items:[{id:'owner'}]});
   if(url.pathname.endsWith('/liveBroadcasts'))return Response.json({items:[{id:'video',snippet:{channelId:'owner',title:'Live',liveChatId:'chat'}}]});
   if(url.pathname.endsWith('/videos'))return Response.json({items:[{id:'video',liveStreamingDetails:{actualStartTime:target==='unknown-viewers'?undefined:new Date(now-60000).toISOString(),concurrentViewers:'7'}}]});
   if(url.pathname.endsWith('/reports'))await stop('request:report');
   return Response.json({items:[],nextPageToken:'next',pollingIntervalMillis:60000,rows:[]});
  };
  connection=new YouTubeConnection(config,db,'http://local/callback','ruslan',request,()=>now);
  try {
   assert.equal(await connection.collectOnce(),300000);assert.equal(hit,true);assert.deepEqual(after,[]);assert.equal(connection.status.state,'disconnected');
  }finally{await connection.stop();await rm(dir,{recursive:true,force:true});}
 });
}
