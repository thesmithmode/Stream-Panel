import type {EventInput} from "../../../packages/core/src/domain.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/server.js';

test('donor nickname HTTP flow crosses the worker boundary and preserves past, future and reimported donations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-donor-http-')),port=43117;
 const app=await createApplication(dir,port,false);
 try{
  const headers={host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`};
  const auth=await app.app.inject({method:'POST',url:'/api/v1/bootstrap',headers,payload:{key:app.bootstrap().split('key=')[1]}});
  assert.equal(auth.statusCode,200,auth.body);
  const signed={...headers,cookie:String(auth.headers['set-cookie']).split(';')[0]!, 'x-csrf-token':auth.json().csrf};
  const person=await app.db.call<{id:string;revision:number}>('createPerson','Target');
  const at=Date.now(),tip=(externalId:string):EventInput=>({source:'donationalerts',accountId:'da',externalId,type:'donation',actor:{externalId:'name:donor',displayName:'Donor'},occurredAtMs:at,receivedAtMs:at,sourceTime:null,timeQuality:'provider',transport:'rest',payload:{amountMinor:'100',currency:'RUB'}});
  await app.db.call('ingest',tip('old'));
  const names=await app.app.inject({url:'/api/v1/donor-nicknames',headers:signed});
  assert.equal(names.statusCode,200,names.body);assert.equal(names.json()[0].name,'Donor');
  const bind=await app.app.inject({method:'POST',url:`/api/v1/persons/${person.id}/donor-bindings`,headers:signed,payload:{name:'Donor',revision:person.revision}});
  assert.equal(bind.statusCode,200,bind.body);assert.equal(bind.json()[0].name,'Donor');
  const conflict=await app.app.inject({method:'POST',url:`/api/v1/persons/${person.id}/donor-bindings`,headers:signed,payload:{name:'Other',revision:person.revision}});
  assert.equal(conflict.statusCode,409,conflict.body);
  const invalid=await app.app.inject({method:'POST',url:`/api/v1/persons/${person.id}/donor-bindings`,headers:signed,payload:{name:'Other',revision:-1}});
  assert.equal(invalid.statusCode,400,invalid.body);
  await app.db.call('ingest',tip('future'));await app.db.call('ingest',tip('old'));
  const donations=await app.app.inject({url:`/api/v1/donations?person=${person.id}`,headers:signed});
  assert.equal(donations.statusCode,200,donations.body);assert.equal(donations.json().total,2);
  const links=await app.app.inject({url:`/api/v1/persons/${person.id}/donor-bindings`,headers:signed});
  assert.equal(links.statusCode,200,links.body);assert.equal(links.json()[0].name,'Donor');
 }finally{await app.app.close();await rm(dir,{recursive:true,force:true});}
});
