import test from 'node:test';import assert from 'node:assert/strict';
import {TwitchConnection} from '../src/twitch.js';import {twitchCatalog} from '../src/twitch-catalog.js';import {YouTubeConnection} from '../src/youtube.js';
import type {Configuration} from '../src/config.js';import type {StoreClient} from '../src/db.js';
test('Twitch catalog paginates, isolates unavailable resources, retains unanalysed fields and reports limits',async()=>{
 for(const mode of ['ok','scope','failure','malformed','loop','partial','cancel-request','cancel-store']){
  let valid=true;const calls:string[]=[],writes:any[]=[];const at=Date.now();
  const scopes=mode==='scope'?[]:twitchCatalog.map(x=>x.scope).filter(Boolean);
  const config={value:{twitchClientId:'id',twitch:{access:'private-token',refresh:'r',expiresAt:at+3600000,userId:'owner',scopes}},save:async()=>{}} as unknown as Configuration;
  const db={call:async(method:string,...args:any[])=>{writes.push([method,...args]);if(mode==='cancel-store')valid=false;}} as unknown as StoreClient;
  const request:typeof fetch=async input=>{
   const u=new URL(String(input)),resource=u.pathname.split('/helix/')[1]!;calls.push(resource);
   if(mode==='cancel-request')valid=false;
   if(resource==='channels'&&mode==='failure')throw new Error('offline');
   if(resource==='videos'&&mode==='malformed')return Response.json({unexpected:'retained'});
   if(resource==='users')assert.equal(u.searchParams.get('id'),'owner');
   if(resource==='videos')assert.equal(u.searchParams.get('user_id'),'owner');
   if(resource==='polls')assert.equal(u.searchParams.get('first'),'20');
   const after=u.searchParams.get('after');
   return Response.json({data:[{future_field:{retained:true}}],pagination:{cursor:resource!=='videos'?'':mode==='loop'?'same':mode==='partial'?String(calls.length):after?'':'next'},total:1});
  };
  const c=new TwitchConnection(config,db,request),runtime=c as unknown as {collectCatalog(account:string,current:()=>boolean,at:number):Promise<void>};
  try{
   await runtime.collectCatalog('owner',()=>valid,at);const before=calls.length;
   await runtime.collectCatalog('owner',()=>valid,at+60000);assert.equal(calls.length,before);
   assert.equal(c.status.state,'disconnected');
   assert.ok(writes.every(x=>x[0]==='providerSnapshot'&&!JSON.stringify(x).includes('private-token')));
   if(mode==='scope')assert.equal(c.status.capabilities['api:subscriptions'],'Нет разрешения');
   if(['malformed','loop'].includes(mode))assert.equal(c.status.capabilities['api:videos'],'Не удалось получить снимок');
   if(mode==='partial')assert.match(c.status.capabilities['api:videos']!,/частично/);
   if(mode==='failure')assert.equal(c.status.capabilities['api:channels'],'Не удалось получить снимок');
   if(mode==='ok'){assert.equal(calls.filter(x=>x==='videos').length,2);assert.deepEqual(writes[0][4].response.data[0],{future_field:{retained:true}});}
   if(mode.startsWith('cancel-'))assert.equal(calls.length,1);
  }finally{await c.stop();}
 }
});
test('late Twitch read and archived YouTube response cannot append data after disconnect',async()=>{
 const at=Date.now();let c:TwitchConnection,writes=0;
 const config={value:{twitchClientId:'id',twitch:{access:'secret',expiresAt:at+3600000,userId:'owner',scopes:[]}},save:async()=>{}} as unknown as Configuration;
 const db={call:async()=>{writes++;}} as unknown as StoreClient;
 c=new TwitchConnection(config,db,async()=>{await c.stop();return Response.json({data:[]});});
 await assert.rejects(c.api('channels?broadcaster_id=owner'),/TWITCH_AUTH_CANCELLED/);assert.equal(writes,0);
 let yt:YouTubeConnection;const ytWrites:any[]=[];
 const ytConfig={value:{youtube:{access:'secret',refresh:'r',expiresAt:at+3600000,userId:'channel',scopes:[]}},save:async()=>{}} as unknown as Configuration;
 const ytDb={call:async(method:string,...args:any[])=>{if(method==='youtubeQuota')return true;ytWrites.push([method,...args]);await yt.stop();}} as unknown as StoreClient;
 yt=new YouTubeConnection(ytConfig,ytDb,'https://panel.test/callback','ruslan',async()=>Response.json({items:[],future_field:'retained'}));
 const api=yt as unknown as {api(resource:string,params:Record<string,string>,tokens:any):Promise<unknown>};
 assert.deepEqual(await api.api('subscriptions',{mySubscribers:'true'},ytConfig.value.youtube),{});
 assert.equal(ytWrites.length,1);assert.equal(ytWrites[0][4].response.future_field,'retained');assert.ok(!JSON.stringify(ytWrites).includes('secret'));
});
test('YouTube archives final metadata in bounded batches and isolates failed or cancelled refreshes',async()=>{
 for(const mode of ['ok','malformed','network','cancel-request','cancel-store']){
  let valid=true;const writes:any[]=[];let requests=0;const at=Date.now();
  const config={value:{youtube:{access:'secret',refresh:'r',expiresAt:at+3600000,userId:'channel',scopes:[]}},save:async()=>{}} as unknown as Configuration;
  const db={call:async(method:string,...args:any[])=>{if(method==='youtubeQuota')return true;writes.push([method,...args]);if(mode==='cancel-store'&&args[1]==='archivedVideoDetails')valid=false;}} as unknown as StoreClient;
  const request:typeof fetch=async input=>{requests++;if(mode==='network')throw new Error('offline');if(mode==='cancel-request')valid=false;const u=new URL(String(input));const ids=u.searchParams.get('id')!.split(',');assert.ok(ids.length<=50);assert.match(u.searchParams.get('part')!,/statistics/);return Response.json(mode==='malformed'?{future_field:'retained'}:{items:ids.map(id=>({id,statistics:{viewCount:'100'},liveStreamingDetails:{actualEndTime:'2026-10-11T12:00:00Z'},future_field:'retained'}))});};
  const yt=new YouTubeConnection(config,db,'https://panel.test/callback','ruslan',request,()=>at);
  const runtime=yt as unknown as {collectArchivedVideos(tokens:any,ids:string[],valid:()=>boolean,at:number):Promise<void>};
  try{
   await runtime.collectArchivedVideos(config.value.youtube,Array.from({length:101},(_,i)=>`video-${i}`),()=>valid,at);
   if(mode==='ok'){assert.equal(requests,3);assert.equal(writes.find(x=>x[2]==='archivedVideoDetails')[3].length,101);assert.equal(writes.at(-1)[2],'cursor:archivedVideos');}
   if(['malformed','network'].includes(mode))assert.equal(writes.at(-1)[2],'archived_video_metadata_unavailable');
   if(mode==='cancel-request')assert.ok(writes.every(x=>x[0]==='providerSnapshot'));
   if(mode==='cancel-store')assert.ok(!writes.some(x=>x[2]==='cursor:archivedVideos'));
  }finally{await yt.stop();}
 }
});
test('completed YouTube broadcasts keep a durable archive cursor before discovery overwrites the live cache',async()=>{
 const at=Date.now(),writes:any[]=[],snapshots:Record<string,any>={channel:{updatedAt:at},report:{updatedAt:at},'cursor:followers':{updatedAt:at},broadcasts:{data:[{id:'finished'},{id:'still-live'},null]},'cursor:archivedVideos':{data:{ids:['old','bad/path'],checkedAt:'invalid'}}};
 let archivedCalls=0;
 const config={value:{youtube:{access:'secret',refresh:'r',expiresAt:at+3600000,userId:'channel',scopes:[]}},save:async()=>{}} as unknown as Configuration;
 const db={call:async(method:string,...args:any[])=>{if(method==='youtubeQuota')return true;if(method==='youtubeData')return {snapshots};writes.push([method,...args]);if(method==='youtubeSnapshot')snapshots[args[1]]={data:args[2],updatedAt:at};}} as unknown as StoreClient;
 const request:typeof fetch=async input=>{const u=new URL(String(input));if(u.pathname.endsWith('/liveBroadcasts'))return Response.json({items:[{id:'still-live',snippet:{channelId:'channel'}}]});if(u.searchParams.get('id')==='still-live')return Response.json({items:[{id:'still-live'}]});archivedCalls++;return Response.json({items:[{id:'finished',statistics:{viewCount:'500'}}]});};
 const yt=new YouTubeConnection(config,db,'https://panel.test/callback','ruslan',request,()=>at);
 try{await yt.collectOnce();assert.deepEqual(snapshots['cursor:archivedVideos'].data,{ids:['finished','old'],checkedAt:at});assert.ok(writes.findIndex(x=>x[2]==='cursor:archivedVideos')<writes.findIndex(x=>x[2]==='broadcasts'));assert.equal(archivedCalls,1);await yt.collectOnce();assert.equal(archivedCalls,1,'archive refresh respects the six-hour interval');}
 finally{await yt.stop();}
});
