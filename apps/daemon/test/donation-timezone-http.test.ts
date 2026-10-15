import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createApplication} from '../src/server.js';
test('saved DA timezone repairs imported donations through HTTP without reconnecting or erasing credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-da-time-http-')),port=43119,app=await createApplication(dir,port,false);
 try{
 const headers={host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`};
 const auth=await app.app.inject({method:'POST',url:'/api/v1/bootstrap',headers,payload:{key:app.bootstrap().split('key=')[1]}});
 const signed={...headers,cookie:String(auth.headers['set-cookie']).split(';')[0]!, 'x-csrf-token':auth.json().csrf};
 const at=Date.UTC(2026,9,12,12),sid=await (app.db.call('startSession','owner','live',at,'platform',at) as Promise<string>);await app.db.call('endSession',sid,at+3600000);
 await app.db.call('ingest',{source:'donationalerts',accountId:'da',externalId:'1',type:'donation',actor:null,occurredAtMs:null,receivedAtMs:at,sourceTime:'2026-10-12 12:10:00',timeQuality:'unknown',transport:'rest',payload:{amountMinor:'5000',currency:'RUB'}});
 assert.equal((await (app.db.call('summary',sid) as Promise<any>)).donations,0);
 const result=await app.app.inject({method:'POST',url:'/api/v1/donationalerts/timezone',headers:signed,payload:{utcOffsetMinutes:0}});
 assert.equal(result.statusCode,200,result.body);assert.equal(result.json().resolved,1);assert.equal((await (app.db.call('summary',sid) as Promise<any>)).donations,1);
 const status=await app.app.inject({url:'/api/v1/status',headers:signed});assert.equal(status.json().config.daUtcOffsetMinutes,0);
 for(const payload of [{utcOffsetMinutes:900},{utcOffsetMinutes:180},{utcOffsetMinutes:'0'},{utcOffsetMinutes:null}])assert.equal((await app.app.inject({method:'POST',url:'/api/v1/donationalerts/timezone',headers:signed,payload})).statusCode,400);
 const rescan=await app.app.inject({method:'POST',url:'/api/v1/donationalerts/rescan',headers:signed,payload:{}});assert.notEqual(rescan.statusCode,200,'a disconnected import cannot report success');
 }finally{await app.app.close();await rm(dir,{recursive:true,force:true});}
});
