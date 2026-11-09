import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/server.js';

test('classification API protects atomic transitions, invalidates cached counts and preserves explicit bot/human endpoints',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-classification-api-')),a=await createApplication(dir,47831,false);
 const host={host:'127.0.0.1:47831'},at=Date.now()-60000;
 try{
  const sid=await a.db.call('startSession','owner','stream',at,'platform',at);
  const event=await a.db.call('ingest',{source:'twitch',accountId:'owner',externalId:'message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}}),id=event.personId!;
  const url=`/api/v1/persons/${id}/classification`;
  assert.equal((await a.app.inject({method:'POST',url,headers:host,payload:{kind:'bot',revision:0}})).statusCode,401);
  const key=new URLSearchParams(a.bootstrap().split('#')[1]).get('key')!;
  const login=await a.app.inject({method:'POST',url:'/api/v1/bootstrap',headers:host,payload:{key}}),cookie=String(login.headers['set-cookie']).split(';')[0]!,headers={...host,cookie,'x-csrf-token':login.json().csrf};
  const state=async()=>(await a.app.inject({method:'GET',url:`/api/v1/persons/${id}/bot`,headers})).json();
  const messages=async()=>(await a.app.inject({method:'GET',url:`/api/v1/summary?session=${sid}`,headers})).json().messages;
  assert.equal(await messages(),1);
  const initial=await state();
  assert.equal((await a.app.inject({method:'POST',url,headers:{...host,cookie},payload:{kind:'bot',revision:initial.revision}})).statusCode,403);
  for(const payload of [{kind:'other',revision:initial.revision},{kind:'bot',revision:'0'},{kind:'bot',revision:initial.revision,extra:true}])assert.equal((await a.app.inject({method:'POST',url,headers,payload})).statusCode,400);
  assert.equal((await a.app.inject({method:'POST',url,headers,payload:{kind:'bot',revision:initial.revision}})).statusCode,200);assert.equal(await messages(),0);
  assert.equal((await a.app.inject({method:'POST',url,headers,payload:{kind:'human',revision:initial.revision}})).statusCode,409);
  for(const kind of ['human','unknown','bot','unknown']){
   const current=await state(),result=await a.app.inject({method:'POST',url,headers,payload:{kind,revision:current.revision}});
   assert.equal(result.statusCode,200);assert.equal(result.json().manualBot,kind==='bot');assert.equal(result.json().manualHuman,kind==='human');assert.equal(await messages(),kind==='bot'?0:1);
  }
  for(const kind of ['human','bot']){const current=await state();assert.equal((await a.app.inject({method:'POST',url:`/api/v1/persons/${id}/${kind}`,headers,payload:{[kind]:true,revision:current.revision}})).statusCode,200);}
  await a.db.call('createDonation',{personId:id,amount:'1',currency:'RUB',occurredAtMs:at,message:'',sourceName:'Manual'},Date.now());
  const automatic=await state();assert.equal(automatic.automaticHuman,true);
  assert.equal((await a.app.inject({method:'POST',url,headers,payload:{kind:'unknown',revision:automatic.revision}})).statusCode,400);
  assert.equal((await a.app.inject({method:'POST',url,headers,payload:{kind:'human',revision:automatic.revision}})).statusCode,200);
 }finally{await a.app.close();await rm(dir,{recursive:true,force:true});}
});
