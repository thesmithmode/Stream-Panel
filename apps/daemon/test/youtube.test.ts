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
  if(url.pathname==='/token'){tokenBodies.push(String(init?.body));return Response.json({access_token:'secret',refresh_token:'refresh',expires_in:mode==='invalid-token'?'oops':3600,scope:mode==='scope'?'none':scopes});}
  if(url.pathname.endsWith('/channels'))return Response.json({items:mode==='multiple'?[{id:'channel'},{id:'other'}]:mode==='changed'?[{id:'other'}]:[{id:'channel',snippet:{title:'Own channel'},statistics:{subscriberCount:'10'}}]});
  if(url.pathname.endsWith('/liveBroadcasts')){assert.equal(url.searchParams.has('mine'),false);return Response.json({items:mode==='offline'?[]:[{id:'live',snippet:{channelId:'channel',liveChatId:'chat'}},{id:'foreign',snippet:{channelId:'foreign',liveChatId:'foreign-chat'}}]});}
  if(url.pathname.endsWith('/messages')){assert.equal(url.searchParams.get('liveChatId'),'chat');return Response.json({nextPageToken:'cursor',pollingIntervalMillis:90000,items:[{id:'msg',snippet:{type:'textMessageEvent',publishedAt:'2026-10-07T12:00:00Z',displayMessage:'private'},authorDetails:{channelId:'viewer'}}]});}
  return Response.json({columnHeaders:[{name:'day'},{name:'views'}],rows:[['2026-10-06',42]]});
 };
 const yt=new YouTubeConnection(config,db,'https://panel.test/oauth/youtube/callback','ruslan',request,()=>now);
 try{
  assert.equal(await yt.collectOnce(),300000);
  await assert.rejects(yt.beginAuth('', 'secret'),/INVALID_YOUTUBE_CLIENT/);
  await assert.rejects(yt.beginAuth('id',''),/MISSING_YOUTUBE_SECRET/);
  const begin=async()=>new URL((await yt.beginAuth('client','clientsecret')).url).searchParams.get('state')!;
  let state=await begin();await assert.rejects(yt.finishAuth('code','bad'),/INVALID_YOUTUBE_STATE/);
  state=await begin();now+=600001;await assert.rejects(yt.finishAuth('code',state),/INVALID_YOUTUBE_STATE/);
  for(const [value,error] of [['scope','YOUTUBE_SCOPES_REQUIRED'],['invalid-token','YOUTUBE_INVALID_TOKEN'],['multiple','YOUTUBE_SELECT_ONE_CHANNEL'],['failure','YOUTUBE_REQUEST_FAILED'],['unauthorized','YOUTUBE_AUTH_REQUIRED'],['forbidden','YOUTUBE_ACCESS_OR_QUOTA']]){
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
  mode='';await yt.collectOnce();assert.match(tokenBodies.at(-1)!,/grant_type=refresh_token/);
  now+=21600001;mode='changed';await assert.rejects(yt.collectOnce(),/YOUTUBE_CHANNEL_CHANGED/);
  mode='offline';assert.equal(await yt.collectOnce(),300000);
  mode='failure';await yt.start();assert.equal(yt.status.state,'error');await yt.stop();
  const day=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  while(await db.call('youtubeQuota',day,'ruslan',1)){};
  mode='';await assert.rejects(yt.collectOnce(),/YOUTUBE_DAILY_BUDGET/);
  await yt.disconnect();assert.equal(config.value.youtube,undefined);assert.equal(yt.status.state,'disconnected');
  await assert.rejects(yt.finishAuth('code','a'.repeat(64)),/INVALID_YOUTUBE_STATE/);
 }finally{await yt.stop();await db.stop();await rm(dir,{recursive:true,force:true});}
});
