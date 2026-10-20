import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountStore} from '../src/auth.js';
import {createHostedApplication} from '../src/hosted.js';
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
    assert.deepEqual(bundled.json().status,status.json());
    const identity=await h.app.inject({url:'/api/v1/auth/me',headers});assert.equal(identity.json().status,undefined);
    if(account==='gulnaz'&&selected==='ruslan')assert.equal((await h.app.inject({url:'/api/v1/status',headers})).statusCode,403);
   }
  }
 }finally{await h.app.close();await rm(dir,{recursive:true,force:true});}
});
