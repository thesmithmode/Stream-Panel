import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {Configuration} from '../src/config.js';
import {createApplication} from '../src/server.js';

test('clip requests require a session and CSRF, deduplicate, and link the matching archive',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'stream-panel-clips-'));
  const config=new Configuration(dir);
  config.value.twitchClientId='test-client';
  config.value.twitch={userId:'42',access:'test',refresh:'test',expiresAt:Date.now()+3600_000,scopes:[]};
  await config.save();
  const start=Math.floor(Date.now()/1000)*1000-30_000;
  const runtime=await createApplication(dir,47831,false,{twitch:{request:async input=>{
    const url=new URL(String(input));
    if(url.pathname==='/helix/streams')return Response.json({data:[
      {id:'200',user_id:'42',type:'live',started_at:new Date(start).toISOString()},
    ]});
    assert.equal(url.pathname,'/helix/videos');
    return Response.json({data:[
      {id:'400',user_id:'42',stream_id:'201',type:'archive'},
      {id:'300',user_id:'42',stream_id:'200',type:'archive'},
    ]});
  }}},{session:request=>request.headers.cookie==='session=test'?{csrf:'test',expires:Number.MAX_SAFE_INTEGER}:null});
  try{
    const session=await runtime.db.call('observePlatformStream','twitch','42','200',start,Date.now(),null,'Test');
    assert.ok(session);
    const url='/api/v1/sessions/'+session+'/clips';
    const headers={host:'127.0.0.1:47831',cookie:'session=test','x-csrf-token':'test'};
    const payload={id:randomUUID(),streamId:'200'};
    const inject=(method:'GET'|'POST',csrf=true)=>runtime.app.inject({method,url,headers:csrf?headers:{...headers,'x-csrf-token':''},...(method==='POST'?{payload}:{})});
    assert.equal((await runtime.app.inject({url,headers:{host:headers.host}})).statusCode,401);
    assert.equal((await inject('POST',false)).statusCode,403);
    const first=await inject('POST');
    assert.equal(first.statusCode,200,first.body);
    assert.ok(first.json().positionSeconds>=30);
    assert.deepEqual((await inject('POST')).json(),first.json());
    assert.equal((await inject('GET')).json().clips[0].url,null);
    await runtime.db.call('endSession',session,Date.now());
    assert.equal((await runtime.app.inject({method:'POST',url,headers,payload:{...payload,id:randomUUID()}})).json().error,'TWITCH_STREAM_OFFLINE');
    const ended=(await inject('GET')).json();
    assert.equal(ended.activeStreamId,null);
    assert.equal(ended.clips.length,1);
    assert.equal(ended.clips[0].url,'https://www.twitch.tv/videos/300?t=0h0m0s');
  }finally{await runtime.app.close();await rm(dir,{recursive:true,force:true});}
});
