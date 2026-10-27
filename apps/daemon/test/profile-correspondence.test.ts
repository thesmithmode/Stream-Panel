import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createHostedApplication} from '../src/hosted.js';
test('one authorized correspondence request preserves latest matching and rejects cross-profile access',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-match-profile-')),h=await createHostedApplication(dir,'https://panel.example.test',false),base={host:'panel.example.test',origin:'https://panel.example.test'};
 try{
  for(const profile of ['ruslan','gulnaz'])await h.accounts.createUser(profile,profile,profile,'fixture-long-password');
  const login=async(username:string)=>{const r=await h.app.inject({method:'POST',url:'/api/v1/auth/login',headers:base,payload:{username,password:'fixture-long-password'}});return {...base,cookie:String(r.headers['set-cookie']).split(';')[0]!};};
  const owner=await login('ruslan'),limited=await login('gulnaz'),at=Date.now()-7200000;
  const a=h.runtimes.get('ruslan')!.db,b=h.runtimes.get('gulnaz')!.db;
  const first=String(await a.call('startSession','a','source',at,'platform',at));await a.call('endSession',first,at+60000);
  const target=String(await b.call('startSession','b','target',at+86400000,'platform',at+86400000));await b.call('endSession',target,at+86460000);
  const url=`/api/v1/sessions/match-profile?session=${encodeURIComponent(first)}&profile=gulnaz`;
  assert.equal((await h.app.inject({url,headers:{...owner,'x-stream-panel-profile':'ruslan'}})).json(),target,'latest source selects latest target even on another day');
  assert.equal((await h.app.inject({url,headers:base})).statusCode,401);
  assert.equal((await h.app.inject({url:url.replace('profile=gulnaz','profile=ruslan'),headers:{...limited,'x-stream-panel-profile':'gulnaz'}})).statusCode,403);
  assert.equal((await h.app.inject({url:url.replace('profile=gulnaz','profile=other'),headers:owner})).statusCode,403);
  assert.equal((await h.app.inject({url:'/api/v1/sessions/match-profile?profile=gulnaz',headers:owner})).statusCode,400);
  assert.equal((await h.app.inject({url:'/api/v1/sessions/match-profile?profile=gulnaz&session=missing',headers:owner})).json(),null);
 }finally{await h.app.close();await rm(dir,{recursive:true,force:true});}
});
