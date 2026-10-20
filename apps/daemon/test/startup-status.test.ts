import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountStore} from '../src/auth.js';
import {createHostedApplication} from '../src/hosted.js';
import {gunzipSync} from 'node:zlib';
test('bundled startup status resolves permissions before reading a profile and matches ordinary status',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-startup-')),origin='http://127.0.0.1:47831';
 const accounts=new AccountStore(join(dir,'data.sqlite'));
 await accounts.createUser('ruslan','ruslan','Ruslan','fixture-ruslan-password');
 await accounts.createUser('gulnaz','gulnaz','Gulnaz','fixture-gulnaz-password');accounts.close();
 const h=await createHostedApplication(dir,origin,false);
 try{
  const requested:string[]=[];
  for(const [profile,runtime] of h.runtimes){const call=runtime.db.call.bind(runtime.db);runtime.db.call=((...args:any[])=>{requested.push(profile);return (call as any)(...args);}) as typeof runtime.db.call;}
  const anon=await h.app.inject({url:'/api/v1/auth/me?status=1',headers:{host:'127.0.0.1:47831'}});assert.equal(anon.statusCode,401);
  for(const account of ['gulnaz','ruslan']){
   const login=await h.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{host:'127.0.0.1:47831',origin},payload:{username:account,password:'fixture-'+account+'-password'}});
   assert.equal(login.statusCode,200);const cookie=login.cookies[0]!.name+'='+login.cookies[0]!.value;
   for(const selected of ['gulnaz','ruslan']){
    requested.length=0;
    const headers={host:'127.0.0.1:47831',cookie,'x-stream-panel-profile':selected},profile=account==='gulnaz'?'gulnaz':selected;
    const bundled=await h.app.inject({url:'/api/v1/auth/me?status=1',headers});assert.equal(bundled.statusCode,200);
    assert.equal(bundled.json().user.accountProfile,account);assert.equal(bundled.json().status.profile,profile);
    assert.ok(requested.length>0);assert.ok(requested.every(p=>p===profile),'must not read a forbidden persisted profile');
    const status=await h.app.inject({url:'/api/v1/status',headers:{...headers,'x-stream-panel-profile':profile}});
    const {database:bundledDatabase,...bundledStatus}=bundled.json().status;
    const {database:ordinaryDatabase,...ordinaryStatus}=status.json();
    assert.equal(bundledDatabase.pending,0);assert.equal(ordinaryDatabase.pending,0);
    assert.equal(typeof bundledDatabase.operations,'object');assert.equal(typeof ordinaryDatabase.operations,'object');
    assert.deepEqual(bundledStatus,ordinaryStatus);
    const identity=await h.app.inject({url:'/api/v1/auth/me',headers});assert.equal(identity.json().status,undefined);
    if(account==='gulnaz'&&selected==='ruslan')assert.equal((await h.app.inject({url:'/api/v1/status',headers})).statusCode,403);
   }
   // Exercise the real hosted forwarding path with an asynchronous onSend hook.
   const runtime=h.runtimes.get(account as 'ruslan'|'gulnaz')!,call=runtime.db.call.bind(runtime.db);
   const report={filters:{fromMs:1,toMs:2},audience:[],padding:'тест'.repeat(10000)};
   runtime.db.call=((...args:any[])=>args[0]==='analytics'?Promise.resolve(report):(call as any)(...args)) as typeof runtime.db.call;
   const compressed=await h.app.inject({url:'/api/v1/analytics?from=1&to=2',headers:{host:'127.0.0.1:47831',cookie,'x-stream-panel-profile':account,'accept-encoding':'gzip'}});
   assert.equal(compressed.statusCode,200);assert.equal(compressed.headers['content-encoding'],'gzip');
   assert.deepEqual(JSON.parse(gunzipSync(compressed.rawPayload).toString()),report,'hosted forwarding must wait for the complete compressed response');
  }
 }finally{await h.app.close();await rm(dir,{recursive:true,force:true});}
});
