import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHostedApplication} from '../src/hosted.js';

test('Gulnaz cannot forge a profile, reveal credentials or reach installation-wide backups',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-access-'));
 await writeFile(join(dir,'key'),'ab'.repeat(32));
 let restored=false;
 const h=await createHostedApplication(dir,'https://panel.test',false,{keyFile:join(dir,'key')},undefined,false,()=>{restored=true;});
 const base={host:'panel.test',origin:'https://panel.test'};
 const login=async(profile:'ruslan'|'gulnaz')=>{
  const response=await h.app.inject({method:'POST',url:'/api/v1/auth/login',headers:base,payload:{username:profile,password:`${profile}-private-password`}});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json().user.allowedProfiles,profile==='ruslan'?['ruslan','gulnaz']:['gulnaz']);
  return {...base,cookie:String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token':response.json().csrf};
 };
 try{
  for(const profile of ['ruslan','gulnaz'] as const)await h.accounts.createUser(profile,profile,profile,`${profile}-private-password`);
  const [owner,member]=await Promise.all([login('ruslan'),login('gulnaz')]);
  const ruslan=h.runtimes.get('ruslan')!;
  ruslan.configuration.value.youtubeClientSecret='owner-secret';await ruslan.configuration.save();
  const ownConfig=JSON.stringify(ruslan.configuration.value);
  for(const url of ['/api/v1/status','/api/v1/persons','/api/v1/analytics?from=1&to=100000','/api/v1/settings','/api/v1/events']){
   const response=await h.app.inject({url,headers:{...member,'x-stream-panel-profile':'ruslan'}});
   assert.equal(response.statusCode,403,url);assert.equal(response.json().error,'PROFILE_FORBIDDEN');assert.ok(!response.body.includes('owner-secret'));
  }
  for(const url of ['/api/v1/settings','/api/v1/twitch/disconnect','/api/v1/donationalerts/connect','/api/v1/youtube/connect','/api/v1/integrations/credentials']){
   assert.equal((await h.app.inject({method:'POST',url,headers:{...member,'x-stream-panel-profile':'ruslan'},payload:{}})).statusCode,403,url);
  }
  assert.equal(JSON.stringify(ruslan.configuration.value),ownConfig,'blocked writes leave Ruslan untouched');
  for(const url of ['/api/v1/integrations/credentials','/api/v1/integrations/%63redentials','/api/v1/integrations/creden%74ials'])assert.equal((await h.app.inject({method:'POST',url,headers:member,payload:{}})).statusCode,403,url);
  const status=await h.app.inject({url:'/api/v1/status',headers:member});
  assert.equal(status.statusCode,200);assert.equal(status.json().user.profile,'gulnaz');assert.equal(status.json().user.canManageBackups,false);assert.equal(status.json().backup,undefined);
  assert.equal((await h.app.inject({method:'POST',url:'/api/v1/twitch/disconnect',headers:member,payload:{}})).statusCode,200);
  for(const [method,url]of [['GET','/api/v1/backups'],['GET','/api/v1/backups/stream-panel-2026-10-14T00-00-00-000Z-aaaaaaaa.spbk'],['POST','/api/v1/backup'],['POST','/api/v1/backup/key'],['POST','/api/v1/backups/restore']] as const){
   const result=await h.app.inject({method,url,headers:member,...(method==='POST'?{payload:{}}:{})});
   assert.equal(result.statusCode,403,url);assert.equal(result.json().error,'BACKUP_FORBIDDEN');
  }
  assert.equal(restored,false);assert.equal(h.backup!.status.local.lastSuccessAt,0);
  const selected={...owner,'x-stream-panel-profile':'gulnaz'};
  const ownerStatus=(await h.app.inject({url:'/api/v1/status',headers:selected})).json();
  assert.equal(ownerStatus.user.profile,'gulnaz');assert.equal(ownerStatus.user.accountProfile,'ruslan');assert.equal(ownerStatus.user.canManageBackups,true);
  assert.equal((await h.app.inject({method:'POST',url:'/api/v1/backup/key',headers:selected,payload:{}})).json().key,'ab'.repeat(32));
  // Identity discovery works even when the browser still has an inaccessible profile selected.
  const me=await h.app.inject({url:'/api/v1/auth/me',headers:{...member,'x-stream-panel-profile':'ruslan'}});
  assert.equal(me.statusCode,200);assert.equal(me.json().user.profile,'gulnaz');
  assert.equal((await h.app.inject({url:'/api/v1/status',headers:{...member,'x-stream-panel-profile':['gulnaz','ruslan']}})).statusCode,400);
 }finally{await h.app.close();await rm(dir,{recursive:true,force:true});}
});
