import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Configuration} from '../src/config.js';
import {YouTubeConnection} from '../src/youtube.js';
import type {StoreClient} from '../src/db.js';
const now = Date.parse('2026-10-19T18:00:00Z');
function fixture(request: typeof fetch, config?: Configuration) {
  const configuration = config ?? {value: {youtubeClientId:'id',youtubeClientSecret:'saved-secret',youtube:{access:'old',refresh:'refresh',userId:'channel',scopes:[],expiresAt:now+3600000}},save:async()=>{}} as unknown as Configuration;
  const db = {call:async(method:string)=> {
    if(method==='youtubeQuota')return true;
    if(method==='youtubeData')return {snapshots:{channel:{updatedAt:now},report:{updatedAt:now},'cursor:followers':{updatedAt:now}}};
  }} as unknown as StoreClient;
  return {config:configuration, yt:new YouTubeConnection(configuration,db,'https://panel.test/oauth/youtube/callback','ruslan',request,()=>now)};
}

test('early Google 401 refreshes once, retries the same read and persists credentials across restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'youtube-refresh-'));
  const config=new Configuration(dir);await config.load();
  config.value.youtubeClientId='id';config.value.youtubeClientSecret='saved-secret';
  config.value.youtube={access:'old',refresh:'refresh',userId:'channel',scopes:[],expiresAt:now+3600000};
  let refreshes=0,reads=0;
  const {yt}=fixture(async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==='/token'){
      refreshes++;const body=new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_secret'),'saved-secret');assert.equal(body.get('refresh_token'),'refresh');
      return Response.json({access_token:'fresh',expires_in:3600});
    }
    reads++;
    if(new Headers(init?.headers).get('Authorization')==='Bearer old')return Response.json({},{status:401});
    return Response.json({items:[]});
  },config);
  try{
    await yt.collectOnce();assert.equal(refreshes,1);assert.equal(reads,2);assert.equal(yt.status.state,'connected');
    const reloaded=new Configuration(dir);await reloaded.load();
    assert.equal(reloaded.value.youtube?.access,'fresh');assert.equal(reloaded.value.youtube?.refresh,'refresh');assert.equal(reloaded.value.youtubeClientSecret,'saved-secret');
  }finally{await yt.stop();await rm(dir,{recursive:true,force:true});}
});

test('parallel 401 responses share one refresh; a second 401 is bounded',async()=>{
  let refreshes=0,reads=0;
  const {yt}=fixture(async(input)=>{
    if(new URL(String(input)).pathname==='/token'){refreshes++;await new Promise(r=>setTimeout(r,10));return Response.json({access_token:'fresh',expires_in:3600});}
    reads++;return Response.json({},{status:401});
  });
  const results=await Promise.allSettled([yt.collectOnce(),yt.collectOnce()]);
  assert.equal(refreshes,1);assert.equal(reads,4);
  for(const result of results){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.match(result.reason.message,/YOUTUBE_AUTH_REQUIRED/);}
  await yt.stop();
});

for(const [status,error,expected] of [[400,'invalid_grant','YOUTUBE_REFRESH_REJECTED'],[401,'invalid_client','YOUTUBE_CLIENT_REJECTED'],[503,'invalid_grant','YOUTUBE_REQUEST_FAILED']] as const){
  test(`refresh ${status} ${error} reports ${expected} and preserves saved credentials`,async()=>{
    const {yt,config}=fixture(async()=>Response.json({error,error_description:'private provider text'},{status}));
    config.value.youtube!.expiresAt=0;
    try{await yt.start();assert.equal(yt.status.detail,expected);assert.equal(config.value.youtube?.refresh,'refresh');assert.equal(config.value.youtubeClientSecret,'saved-secret');}
    finally{await yt.stop();}
  });
}

test('quota and server errors do not refresh or discard the connection',async()=>{
  for(const status of [403,500]){
    let calls=0;
    const {yt,config}=fixture(async input=>{calls++;assert.notEqual(new URL(String(input)).pathname,'/token');return Response.json({},{status});});
    try{await yt.start();assert.equal(calls,1);assert.equal(yt.status.state,'error');assert.ok(config.value.youtube);}
    finally{await yt.stop();}
  }
});

test('cancelled and failed reconnect preserve existing tokens and client secret; saved secret can be reused',async()=>{
  const {yt,config}=fixture(async(input,init)=>{
    assert.equal(new URL(String(input)).pathname,'/token');
    assert.equal(new URLSearchParams(String(init?.body)).get('client_secret'),'saved-secret');
    return Response.json({error:'invalid_grant'},{status:400});
  });
  const before=JSON.stringify(config.value);
  const state=new URL((await yt.beginAuth('id','')).url).searchParams.get('state')!;
  assert.equal(JSON.stringify(config.value),before);
  await assert.rejects(yt.finishAuth('bad-code',state),/YOUTUBE_REFRESH_REJECTED/);
  assert.equal(JSON.stringify(config.value),before);
  await assert.rejects(yt.beginAuth('different-client',''),/MISSING_YOUTUBE_SECRET/);
  assert.equal(JSON.stringify(config.value),before);
  await yt.stop();
});
