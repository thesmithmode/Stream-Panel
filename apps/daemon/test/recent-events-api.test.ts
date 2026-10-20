import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostedApplication} from '../src/hosted.js';
import type {EventInput} from '../../../packages/core/src/domain.js';

test('recent archive API requires login, stays profile-scoped and bounds response pages',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-recent-api-')),host='panel.example.test';
 const h=await createHostedApplication(dir,`https://${host}`,false),base={host,origin:`https://${host}`};
 try{
  await h.accounts.createUser('ruslan','ruslan','Руслан','recent-archive-password');
  const login=await h.app.inject({method:'POST',url:'/api/v1/auth/login',headers:base,payload:{username:'ruslan',password:'recent-archive-password'}});
  assert.equal(login.statusCode,200);
  const headers={...base,cookie:String(login.headers['set-cookie']).split(';')[0]!};
  const at=Date.now()-1000;
  const event:EventInput={source:'twitch',accountId:'owner',externalId:'message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'Руслан'}};
  await h.runtimes.get('ruslan')!.db.call('ingest',event);
  await h.runtimes.get('gulnaz')!.db.call('ingest',{...event,payload:{text:'Гульназ'}});
  assert.equal((await h.app.inject({url:'/api/v1/events/recent',headers:base})).statusCode,401);
  const mine=await h.app.inject({url:'/api/v1/events/recent',headers});assert.equal(mine.statusCode,200);assert.equal(mine.json()[0].payload.text,'Руслан');
  const people=await h.runtimes.get('ruslan')!.db.call('persons');
  const person=String(people[0]!.id);
  const filtered=await h.app.inject({url:`/api/v1/events/recent?person=${encodeURIComponent(person)}&messages=1`,headers});assert.equal(filtered.statusCode,200);assert.equal(filtered.json()[0].payload.text,'Руслан');
  assert.deepEqual((await h.app.inject({url:'/api/v1/events/recent?person=missing&messages=1',headers})).json(),[]);
  assert.deepEqual((await h.app.inject({url:'/api/v1/events/recent?session=missing',headers})).json(),[]);
  const peer=await h.app.inject({url:'/api/v1/events/recent?offset=0&limit=1',headers:{...headers,'x-stream-panel-profile':'gulnaz'}});assert.equal(peer.statusCode,200);assert.equal(peer.json()[0].payload.text,'Гульназ');
  assert.deepEqual((await h.app.inject({url:'/api/v1/events/recent?offset=1',headers})).json(),[]);
  for(const q of ['offset=-1','limit=201','limit=0','offset=NaN'])assert.equal((await h.app.inject({url:`/api/v1/events/recent?${q}`,headers})).statusCode,400);
 }finally{await h.app.close();await rm(dir,{recursive:true,force:true});}
});
