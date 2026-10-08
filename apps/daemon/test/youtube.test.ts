import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Configuration} from '../src/config.js';
import {StoreClient} from '../src/db.js';
import {YouTubeConnection} from '../src/youtube.js';
const scopes='https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly';
test('YouTube OAuth binds state and PKCE; refresh, owner filtering, durable cursors, quota and disconnect work',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-youtube-'));const config=new Configuration(dir);await config.load();
 const db=new StoreClient(join(dir,'data.sqlite'),'ruslan');await db.ready;
 let now=Date.parse('2026-10-07T12:00:00Z'), mode='', calls:URL[]=[],tokenBodies:string[]=[];
 const request:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));calls.push(url);
  if(mode==='failure')return Response.json({}, {status:500});
  if(mode==='unauthorized')return Response.json({}, {status:401});
  if(mode==='forbidden')return Response.json({}, {status:403});
  if(url.pathname==='/token'){tokenBodies.push(String(init?.body));return Response.json({access_token:'secret',refresh_token:mode==='refresh-without-rotation'?undefined:'refresh',expires_in:mode==='invalid-token'?'oops':mode==='invalid-expiry'?-1:3600,scope:mode==='scope'?'none':scopes});}
  if(url.pathname.endsWith('/channels'))return Response.json(mode==='missing-channel'?{}:{items:mode==='multiple'?[{id:'channel'},{id:'other'}]:mode==='changed'?[{id:'other'}]:[{id:'channel',snippet:{title:'Own channel'},statistics:{subscriberCount:'10'}}]});
  if(url.pathname.endsWith('/liveBroadcasts')){assert.equal(url.searchParams.has('mine'),false);return Response.json({items:mode==='offline'?[]:[{id:'live',snippet:{channelId:'channel',liveChatId:'chat'}},{id:'foreign',snippet:{channelId:'foreign',liveChatId:'foreign-chat'}}]});}
  if(url.pathname.endsWith('/messages')){assert.equal(url.searchParams.get('liveChatId'),'chat');return Response.json({nextPageToken:'cursor',pollingIntervalMillis:90000,items:mode==='empty-chat'?undefined:[{id:'msg',snippet:{type:'textMessageEvent',publishedAt:'2026-10-07T12:00:00Z',displayMessage:'private'},authorDetails:{channelId:'viewer'}}]});}
  return Response.json({columnHeaders:[{name:'day'},{name:'views'}],rows:[['2026-10-06',42]]});
 };
 const yt=new YouTubeConnection(config,db,'https://panel.test/oauth/youtube/callback','ruslan',request,()=>now);
 try{
  assert.equal(await yt.collectOnce(),300000);
  await assert.rejects(yt.beginAuth('', 'secret'),/INVALID_YOUTUBE_CLIENT/);
  await assert.rejects(yt.beginAuth('x'.repeat(257),'secret'),/INVALID_YOUTUBE_CLIENT/);
  await assert.rejects(yt.beginAuth('id','x'.repeat(257)),/INVALID_YOUTUBE_CLIENT/);
  await assert.rejects(yt.beginAuth('id',''),/MISSING_YOUTUBE_SECRET/);
  const begin=async()=>new URL((await yt.beginAuth('client','clientsecret')).url).searchParams.get('state')!;
  let state=await begin();await assert.rejects(yt.finishAuth('code','bad'),/INVALID_YOUTUBE_STATE/);
  state=await begin();now+=600001;await assert.rejects(yt.finishAuth('code',state),/INVALID_YOUTUBE_STATE/);
  for(const [value,error] of [['missing-channel','YOUTUBE_SELECT_ONE_CHANNEL'],['scope','YOUTUBE_SCOPES_REQUIRED'],['invalid-token','YOUTUBE_INVALID_TOKEN'],['invalid-expiry','YOUTUBE_INVALID_TOKEN'],['multiple','YOUTUBE_SELECT_ONE_CHANNEL'],['failure','YOUTUBE_REQUEST_FAILED'],['unauthorized','YOUTUBE_AUTH_REQUIRED'],['forbidden','YOUTUBE_ACCESS_OR_QUOTA']]){
   state=await begin();mode=value!;await assert.rejects(yt.finishAuth('code',state),new RegExp(error!));
  }
  mode='';state=await begin();await yt.finishAuth('code',state);
  for(let i=0;i<100 && yt.status.state!=='connected';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(yt.status.state,'connected',yt.status.detail);await yt.stop();
  assert.equal(config.value.youtube?.userId,'channel');assert.match(tokenBodies.at(-1)!,/code_verifier=/);
  const data=await db.call<any>('youtubeData','channel');assert.equal(data.messages.length,1);assert.equal(data.snapshots.report.data.rows[0][1],42);
  assert.equal(await yt.collectOnce(),90000);assert.equal((await db.call<any>('youtubeData','channel')).messages.length,1);
  assert.equal(calls.filter(x=>x.pathname.endsWith('/messages')).at(-1)?.searchParams.get('pageToken'),'cursor');
  config.value.youtube!.expiresAt=0;mode='invalid-token';await assert.rejects(yt.collectOnce(),/YOUTUBE_INVALID_TOKEN/);
  mode='invalid-expiry';await assert.rejects(yt.collectOnce(),/YOUTUBE_INVALID_TOKEN/);
  mode='refresh-without-rotation';await yt.collectOnce();assert.match(tokenBodies.at(-1)!,/grant_type=refresh_token/);assert.equal(config.value.youtube!.refresh,'refresh');
  mode='empty-chat';assert.equal(await yt.collectOnce(),90000);assert.equal((await db.call<any>('youtubeData','channel')).messages.length,1);
  now+=21600001;mode='missing-channel';await assert.rejects(yt.collectOnce(),/YOUTUBE_CHANNEL_CHANGED/);
  now+=21600001;mode='changed';await assert.rejects(yt.collectOnce(),/YOUTUBE_CHANNEL_CHANGED/);
  mode='offline';assert.equal(await yt.collectOnce(),300000);
  mode='failure';await yt.start();assert.equal(yt.status.state,'error');await yt.stop();
  const day=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  while(await db.call('youtubeQuota',day,'ruslan',1)){};
  mode='';await assert.rejects(yt.collectOnce(),/YOUTUBE_DAILY_BUDGET/);
  await yt.disconnect();assert.equal(config.value.youtube,undefined);assert.equal(config.value.youtubeAccountId,'channel');assert.equal(yt.status.state,'disconnected');
  await assert.rejects(yt.finishAuth('code','a'.repeat(64)),/INVALID_YOUTUBE_STATE/);
 }finally{await yt.stop();await db.stop();await rm(dir,{recursive:true,force:true});}
});

test('YouTube cancellation at OAuth, refresh, channel, broadcast, messages and report awaits cannot resurrect credentials or append stale data',async()=>{
 for(const phase of ['oauth-token','oauth-channel','refresh','channel','broadcast','videos','messages','report']){
  let resolve:((r:Response)=>void)|undefined,entered:()=>void=()=>{},gate=new Promise<void>(r=>entered=r),writes:any[]=[];
  const config={value:{youtubeClientId:'id',youtubeClientSecret:'secret',youtube:{access:'old',refresh:'r',userId:'channel',scopes:scopes.split(' '),expiresAt:phase==='refresh'?0:Date.now()+3600000}},save:async()=>{}} as unknown as Configuration;
  const data={snapshots:{channel:{updatedAt:phase==='channel'?0:Date.now()},report:{updatedAt:phase==='report'?0:Date.now()}},messages:[]};
  const db={call:async(method:string,...args:any[])=>{if(method==='youtubeQuota')return true;if(method==='youtubeData')return data;writes.push([method,...args]);return null;}} as unknown as StoreClient;
  const request:typeof fetch=async(input,init)=>{
   const path=new URL(String(input)).pathname;
   const delayed=phase==='oauth-token'&&path==='/token'||phase==='oauth-channel'&&path.endsWith('/channels')||phase==='refresh'&&path==='/token'||phase==='channel'&&path.endsWith('/channels')||phase==='broadcast'&&path.endsWith('/liveBroadcasts')||phase==='videos'&&path.endsWith('/videos')||phase==='messages'&&path.endsWith('/messages')||phase==='report'&&path.endsWith('/reports');
   const response=path==='/token'?{access_token:'fresh',refresh_token:'fresh-refresh',scope:scopes,expires_in:3600}:path.endsWith('/channels')?{items:[{id:'channel'}]}:path.endsWith('/liveBroadcasts')?{items:[{id:'live',snippet:{channelId:'channel',liveChatId:'chat'}}]}:path.endsWith('/messages')?{items:[{id:'stale'}],nextPageToken:'stale-cursor'}:{};
   if(delayed){entered();return new Promise(r=>{resolve=()=>r(Response.json(response));});}return Response.json(response);
  };
  const yt=new YouTubeConnection(config,db,'https://panel.test/oauth/youtube/callback','ruslan',request);
  let pending:Promise<unknown>;
  if(phase.startsWith('oauth-')){const state=new URL((await yt.beginAuth('id','secret')).url).searchParams.get('state')!;pending=yt.finishAuth('code',state);}else pending=yt.collectOnce();
  await gate;const before=writes.length;const stopped=yt.disconnect();resolve!(Response.json({}));await pending;await stopped;
  assert.equal(config.value.youtube,undefined,phase);assert.equal(writes.length,before,phase);assert.equal(yt.status.state,'disconnected');
 }
});

test('YouTube pagination and malformed optional API fields remain bounded and report a safe failure',async()=>{
 const config={value:{youtubeClientId:'id',youtubeClientSecret:'s',youtube:{access:'a',refresh:'r',userId:'channel',scopes:[],expiresAt:Date.now()+3600000}},save:async()=>{}} as unknown as Configuration;
 let pageCalls=0,mode='pages';const writes:any[]=[];
 const db={call:async(method:string,...args:any[])=>{if(method==='youtubeQuota')return true;if(method==='youtubeData')return {snapshots:{},messages:[]};writes.push([method,...args]);return null;}} as unknown as StoreClient;
 const request:typeof fetch=async(input)=>{
  const url=new URL(String(input));if(mode==='network')throw new Error('network broken');
  if(url.pathname.endsWith('/channels'))return Response.json({items:[{id:'channel'}]});
  if(url.pathname.endsWith('/liveBroadcasts')){pageCalls++;return Response.json(mode==='missing'?{}:{nextPageToken:pageCalls===1?'next':'',items:[{id:'no-chat',snippet:{channelId:'channel'}}]});}
  return Response.json({});
 };
 const yt=new YouTubeConnection(config,db,'https://panel.test/oauth/youtube/callback','ruslan',request);
 try{assert.equal(await yt.collectOnce(),60000);assert.equal(pageCalls,2);mode='missing';assert.equal(await yt.collectOnce(),300000);mode='network';await yt.start();assert.equal(yt.status.detail,'YOUTUBE_CONNECTION_FAILED');}
 finally{await yt.stop();}
});

test('live viewer counts match exact broadcast IDs and preserve unknown for hidden, duplicate, negative and overflowing values',async()=>{
 let payload:any={},calls:any[]=[];
 const now=Date.now(),config={value:{youtube:{access:'a',refresh:'r',userId:'channel',scopes:[],expiresAt:now+3600000}},save:async()=>{}} as unknown as Configuration;
 const db={call:async(method:string,...args:any[])=>{if(method==='youtubeQuota')return true;if(method==='youtubeData')return {snapshots:{channel:{updatedAt:now},report:{updatedAt:now}}};calls.push([method,...args]);}} as unknown as StoreClient;
 const request:typeof fetch=async input=>{const path=new URL(String(input)).pathname;return Response.json(path.endsWith('/liveBroadcasts')?{items:[{id:'live',snippet:{channelId:'channel'}}]}:payload);};
 const yt=new YouTubeConnection(config,db,'https://panel.test/oauth/youtube/callback','ruslan',request,()=>now);
 try {
  for(const [items,expected]of [
   [[{id:'live',liveStreamingDetails:{concurrentViewers:'12'}}],12],
   [[{id:'wrong',liveStreamingDetails:{concurrentViewers:'12'}}],null],
   [[{id:'live',liveStreamingDetails:{concurrentViewers:'-1'}}],null],
   [[{id:'live',liveStreamingDetails:{concurrentViewers:''}}],null],
   [[{id:'live',liveStreamingDetails:{}}],null],
   [[{id:'live',liveStreamingDetails:{concurrentViewers:'9007199254740992'}}],null],
   [[{id:'live',liveStreamingDetails:{concurrentViewers:'12'}},{id:'live',liveStreamingDetails:{concurrentViewers:'12'}}],null],
  ] as [any[],number|null][]){payload={items};calls=[];await yt.collectOnce();assert.equal(calls.find(x=>x[0]==='youtubeViewers')?.[2],expected);}
 }finally{await yt.stop();}
});

test('disconnect while loading persisted cursors cannot issue requests or append data after that read resolves',async()=>{
 let resolveRead:(v:unknown)=>void=()=>{},entered:()=>void=()=>{};const gate=new Promise<void>(r=>entered=r);const now=Date.now();let requests=0;
 const config={value:{youtube:{access:'a',refresh:'r',userId:'channel',scopes:[],expiresAt:now+3600000}},save:async()=>{}} as unknown as Configuration;
 const db={call:async()=>{entered();return new Promise(r=>resolveRead=r);}} as unknown as StoreClient;
 const request:typeof fetch=async()=>{requests++;throw new Error('must not request after disconnect');};
 const yt=new YouTubeConnection(config,db,'https://panel.test/oauth/youtube/callback','ruslan',request,()=>now);
 const collecting=yt.collectOnce();await gate;await yt.disconnect();resolveRead({snapshots:{}});await collecting;
 assert.equal(requests,0);assert.equal(yt.status.state,'disconnected');assert.equal(config.value.youtube,undefined);
});
