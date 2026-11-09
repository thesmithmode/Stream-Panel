import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createApplication} from '../src/server.js';import {Configuration,secondaryYouTubeConfiguration} from '../src/config.js';
import {YouTubeConnection} from '../src/youtube.js';import type {StoreClient} from '../src/db.js';
test('secondary OAuth has independent credentials and callback state; restarts and disconnect preserve the primary account',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-secondary-'));const now=Date.now();let channel='second',mode='live';const paths:string[]=[];
 const request:typeof fetch=async input=>{
  const url=new URL(String(input));paths.push(url.pathname);
  if(url.pathname==='/token')return Response.json({access_token:'second-access',refresh_token:'second-refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/youtube.readonly'});
  if(url.pathname.endsWith('/channels'))return Response.json({items:[{id:channel,snippet:{title:'Second'}}]});
  if(url.pathname.endsWith('/liveBroadcasts'))return Response.json({items:mode==='offline'?[]:[{id:'video',snippet:{channelId:'second',liveChatId:'chat'}}]});
  if(url.pathname.endsWith('/messages'))return Response.json({items:[{id:'msg',snippet:{type:'textMessageEvent',publishedAt:new Date(now-1000).toISOString(),displayMessage:'Second chat'},authorDetails:{channelId:'viewer',displayName:'Second viewer'}}],nextPageToken:'next',pollingIntervalMillis:65000});
  throw new Error('Unexpected request '+url.pathname);
 };
 const a=await createApplication(dir,47831,false,{youtube:{request}});
 try{
  const primary={access:'primary-access',refresh:'primary-refresh',userId:'primary',expiresAt:now+3600000,scopes:[]};a.configuration.value.youtube=primary;await a.configuration.save();
  const bootstrap=await a.app.inject({method:'POST',url:'/api/v1/bootstrap',payload:{key:new URL(a.bootstrap()).hash.slice(5)},headers:{host:'127.0.0.1:47831',origin:'http://127.0.0.1:47831'}});
  const headers={host:'127.0.0.1:47831',cookie:String(bootstrap.headers['set-cookie']).split(';')[0]!,origin:'http://127.0.0.1:47831','x-csrf-token':bootstrap.json().csrf};
  assert.equal(bootstrap.statusCode,200,bootstrap.body);
  const begin=async()=>{const response=await a.app.inject({method:'POST',url:'/api/v1/youtube/connect',headers,payload:{account:'secondary',clientId:'second-client',clientSecret:'second-secret'}});assert.equal(response.statusCode,200,response.body);return new URL(response.json().url).searchParams.get('state')!;};
  channel='primary';let state=await begin();let response=await a.app.inject({url:`/oauth/youtube/callback?code=fixture&state=${state}`,headers});assert.equal(response.statusCode,400);assert.equal(a.configuration.value.youtubeSecondary,undefined);
  channel='second';state=await begin();response=await a.app.inject({url:`/oauth/youtube/callback?code=fixture&state=${state}`,headers});assert.equal(response.statusCode,302,response.body);
  await a.youtubeSecondary.stop();assert.equal(await a.youtubeSecondary.collectOnce(),65000);
  assert.equal(a.configuration.value.youtube,primary);assert.equal((a.configuration.value as import('../src/config.js').Config).youtubeSecondary?.userId,'second');
  const data=await a.db.call('youtubeData','second');assert.equal(data.messages.length,1);assert.equal(data.snapshots.collectionRole!.data,'secondary');assert.equal(data.subscriberCountAt,null);assert.equal((await a.db.call('sessions')).length,0);
  assert.ok(paths.every(path=>!['/v2/reports','/youtube/v3/videos','/youtube/v3/subscriptions'].includes(path)));
  const reloaded=new Configuration(dir);await reloaded.load();assert.equal(reloaded.value.youtube?.access,'primary-access');assert.equal(reloaded.value.youtubeSecondary?.access,'second-access');
  const status=(await a.app.inject({url:'/api/v1/status',headers})).json();assert.equal(status.config.hasYoutubeSecondarySecret,true);assert.ok(!JSON.stringify(status).includes('second-secret'));
  response=await a.app.inject({method:'POST',url:'/api/v1/youtube/connect',headers,payload:{account:'unexpected',clientId:'x'}});assert.equal(response.statusCode,400);
  mode='offline';assert.equal(await a.youtubeSecondary.collectOnce(),300000);
  response=await a.app.inject({method:'POST',url:'/api/v1/youtube/disconnect',headers,payload:{account:'secondary'}});assert.equal(response.statusCode,200);assert.equal(a.configuration.value.youtube,primary);assert.equal(a.configuration.value.youtubeSecondary,undefined);
  assert.equal(await a.youtubeSecondary.collectOnce(),300000);
 }finally{await a.app.close();await rm(dir,{recursive:true,force:true});}
});
test('secondary collector ignores a late chat response after disconnect',async()=>{
 const config={value:{version:1,youtubeSecondary:{access:'a',refresh:'r',userId:'second',expiresAt:Date.now()+3600000,scopes:[]}},save:async()=>{}} as unknown as Configuration;
 let release!:(r:Response)=>void,entered!:()=>void;const gate=new Promise<void>(r=>entered=r),writes:string[]=[];
 const db={call:async(method:string)=>{if(method==='youtubeQuota')return true;if(method==='youtubeData')return {snapshots:{}};writes.push(method);}} as unknown as StoreClient;
 const yt=new YouTubeConnection(secondaryYouTubeConfiguration(config),db,'https://panel.test/oauth/youtube/callback','ruslan',async input=>{
  if(String(input).includes('liveBroadcasts'))return Response.json({items:[{id:'video',snippet:{channelId:'second',liveChatId:'chat'}}]});
  entered();return new Promise(r=>release=r);
 },Date.now,{chatOnly:true});
 const collect=yt.collectOnce();await gate;const before=writes.length;await yt.disconnect();release(Response.json({items:[{id:'late'}]}));await collect;assert.equal(writes.length,before);assert.equal(config.value.youtubeSecondary,undefined);
});
