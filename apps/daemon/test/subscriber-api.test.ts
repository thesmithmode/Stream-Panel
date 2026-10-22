import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createApplication} from '../src/server.js';
test('subscriber endpoint binds the configured channel, validates windows and never accepts an arbitrary account',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subscriber-api-')),a=await createApplication(dir,47831,false);
 try{
  const key=new URLSearchParams(a.bootstrap().split('#')[1]).get('key');const login=await a.app.inject({method:'POST',url:'/api/v1/bootstrap',headers:{host:'127.0.0.1:47831'},payload:{key}});const headers={host:'127.0.0.1:47831',cookie:String(login.headers['set-cookie']).split(';')[0]!};
  a.configuration.value.youtubeAccountId='yt';await a.db.call('youtubeSnapshot','yt','channel',{statistics:{subscriberCount:'10'}},1000);await a.db.call('youtubeSnapshot','other','channel',{statistics:{subscriberCount:'999'}},1000);
  const url='/api/v1/analytics/subscribers?source=youtube&from=0&to=2000&account=other';const r=await a.app.inject({url,headers});assert.equal(r.statusCode,200);assert.equal(r.json().total,10);
  for(const q of ['source=all&from=0&to=2000','source=youtube&from=bad&to=2000','source=youtube&from=2000&to=1','source=youtube&from=0&to=999999999999'])assert.equal((await a.app.inject({url:'/api/v1/analytics/subscribers?'+q,headers})).statusCode,400);
  delete a.configuration.value.youtubeAccountId;const empty=await a.app.inject({url,headers});assert.equal(empty.json().total,null);
 }finally{await a.app.close();await rm(dir,{recursive:true,force:true});}
});
