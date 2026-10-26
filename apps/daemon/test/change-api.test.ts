import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/server.js';
test('screen versions require authentication, expose no credentials and scope warming to the current screen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'change-api-')),a=await createApplication(dir,47831,false);
 try{
  const host={host:'127.0.0.1:47831'};
  assert.equal((await a.app.inject({url:'/api/v1/changes',headers:host})).statusCode,401);
  const key=new URLSearchParams(a.bootstrap().split('#')[1]).get('key');
  const login=await a.app.inject({method:'POST',url:'/api/v1/bootstrap',headers:host,payload:{key}});
  const headers={...host,cookie:String(login.headers['set-cookie']).split(';')[0]!};
  a.configuration.value.daAccessToken='private-fixture-token';
  const read=async(view:string)=>(await a.app.inject({url:'/api/v1/changes?viewer=fixture-browser&view='+view,headers})).json();
  const first=await read('overview');assert.equal(first.activeStream,null);assert.ok(first.dataEpoch);assert.ok(first.sync);assert.ok(!JSON.stringify(first).includes('private-fixture-token'));
  await read('analytics');
  await read('people');
  await a.db.call('createPerson','New person');const next=await read('overview');assert.ok(next.versions.people>first.versions.people);assert.equal(next.dataEpoch,first.dataEpoch);assert.equal(next.connectionRevision,first.connectionRevision);
 }finally{await a.app.close();await rm(dir,{recursive:true,force:true});}
});
