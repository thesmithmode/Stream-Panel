import test from 'node:test';import assert from 'node:assert/strict';
import {TwitchConnection} from '../src/twitch.js';import {YouTubeConnection} from '../src/youtube.js';
import type {Configuration} from '../src/config.js';import type {StoreClient} from '../src/db.js';
test('successful Twitch reads no longer archive diagnostic responses',async()=>{
 const now=Date.now(),config={value:{twitchClientId:'id',twitch:{access:'secret',refresh:'r',expiresAt:now+3600000,userId:'owner',scopes:[]}},save:async()=>{}} as unknown as Configuration;
 const db={call:async()=>{assert.fail('a successful API read must not write a raw snapshot');}} as unknown as StoreClient;
 const c=new TwitchConnection(config,db,async()=>Response.json({data:[{future_field:'unused'}]}));
 try{assert.deepEqual(await c.api('channels?broadcaster_id=owner'),{data:[{future_field:'unused'}]});}finally{await c.stop();}
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
 yt=new YouTubeConnection(ytConfig,ytDb,'https://panel.test/callback','ruslan',async()=>{await yt.stop();return Response.json({items:[],future_field:'retained'});});
 const api=yt as unknown as {api(resource:string,params:Record<string,string>,tokens:any):Promise<unknown>};
 assert.deepEqual(await api.api('subscriptions',{mySubscribers:'true'},ytConfig.value.youtube),{});
 assert.equal(ytWrites.length,0);
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
test('retired Twitch and DA sockets cannot change status or recreate keepalive timers',async()=>{
 const {EventEmitter}=await import('node:events');const {DonationAlertsConnection}=await import('../src/donationalerts.js');
 for(const provider of ['twitch','da'])for(const retirement of ['stop','generation','removed']){
  const config={value:{twitch:{access:'fixture',userId:'owner',scopes:[]},daAccessToken:'fixture'},save:async()=>{}} as unknown as Configuration;
  let writes=0;const db={call:async()=>{writes++;}} as unknown as StoreClient;
  const socket=new EventEmitter() as any;socket.send=()=>{};socket.close=()=>socket.emit('close');socket.terminate=()=>{};
  const request:typeof fetch=async()=>{assert.fail('late publication must not request');};
  const c=provider==='twitch'?new TwitchConnection(config,db,request,()=>socket):new DonationAlertsConnection(config,db,request,()=>socket);const runtime=c as any;
  runtime.stopped=false;if(provider==='twitch')runtime.connect();else runtime.connect('fixture',runtime.generation);
  try{
   socket.emit('error',new Error('current failure'));assert.equal(provider==='twitch'?c.status.detail:c.status.capabilities.realtime,'Ошибка WebSocket');
   if(retirement==='stop')await c.stop();
   if(retirement==='generation')runtime[provider==='twitch'?'authGeneration':'generation']++;
   if(retirement==='removed'){runtime.socket=null;if(provider==='twitch')runtime.sockets.delete(socket);}
   const prior=JSON.stringify(c.status);socket.emit('error',new Error('late failure'));socket.emit('message','invalid obsolete JSON');
   for(let n=0;n<3;n++)await new Promise(r=>setImmediate(r));assert.equal(JSON.stringify(c.status),prior);assert.equal(writes,0);
  }finally{socket.close();await c.stop();}
 }
});
test('Twitch successful API reads do not enter the obsolete archive-write boundary',async()=>{
 const now=Date.now(),config={value:{twitchClientId:'id',twitch:{access:'fixture',refresh:'r',expiresAt:now+3600000,userId:'owner',scopes:[]}},save:async()=>{}} as unknown as Configuration;
 const db={call:async()=>{assert.fail('diagnostic storage must not be called');}} as unknown as StoreClient;
 const c=new TwitchConnection(config,db,async()=>Response.json({data:[]}));
 try{assert.deepEqual(await c.api('streams?user_id=owner'),{data:[]});}finally{await c.stop();}
});

test('YouTube resumes final metadata collection from a durable cursor after cancellation or unavailable responses',async()=>{
 for(const mode of ['register-cancel','metadata-cancel','archive-cancel','network','malformed','old-array','old-string']){
  const at=Date.now(),snapshots:Record<string,any>={channel:{updatedAt:at},report:{updatedAt:at},'cursor:followers':{updatedAt:at},broadcasts:{data:[{id:'finished'}]},'cursor:archivedVideos':{data:mode==='old-array'?[]:mode==='old-string'?'legacy':{ids:[],checkedAt:0}}};
  let yt:YouTubeConnection,first=true,calls=0;const writes:string[]=[];
  const config={value:{youtube:{access:'fixture',refresh:'r',expiresAt:at+3600000,userId:'channel',scopes:[]}},save:async()=>{}} as unknown as Configuration;
  const db={call:async(method:string,...args:any[])=>{
   if(method==='youtubeQuota')return true;if(method==='youtubeData')return {snapshots};writes.push(`${method}:${args[1]}`);
   if(method==='youtubeSnapshot')snapshots[args[1]]={data:args[2],updatedAt:at};
   if(first&&((mode==='register-cancel'&&method==='youtubeSnapshot'&&args[1]==='cursor:archivedVideos')||(mode==='archive-cancel'&&method==='youtubeSnapshot'&&args[1]==='archivedVideoDetails')))await yt.stop();
  }} as unknown as StoreClient;
  const request:typeof fetch=async input=>{
   if(String(input).includes('/liveBroadcasts'))return Response.json({items:[]});calls++;if(first&&mode==='metadata-cancel')await yt.stop();
   if(first&&mode==='network')throw new Error('unavailable');return Response.json(first&&mode==='malformed'?{}:{items:[{id:'finished',statistics:{viewCount:'500'},future_field:'retained'}]});
  };
  yt=new YouTubeConnection(config,db,'https://panel.test/callback','ruslan',request,()=>at);
  try{
   await yt.collectOnce();assert.deepEqual(snapshots['cursor:archivedVideos'].data.ids,['finished']);
   if(mode.endsWith('-cancel')||['network','malformed'].includes(mode))assert.equal(snapshots['cursor:archivedVideos'].data.checkedAt,0);
   if(['network','malformed'].includes(mode))assert.ok(writes.includes('gap:archived_video_metadata_unavailable'));
   if(mode==='register-cancel')assert.equal(calls,0);
   await yt.stop();first=false;yt=new YouTubeConnection(config,db,'https://panel.test/callback','ruslan',request,()=>at);await yt.collectOnce();assert.equal(snapshots['cursor:archivedVideos'].data.checkedAt,at);assert.equal(snapshots.archivedVideoDetails.data[0].statistics.viewCount,'500');
  }finally{await yt.stop();}
 }
});
