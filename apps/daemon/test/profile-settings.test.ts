import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHostedApplication} from '../src/hosted.js';
test('settings are validated, isolated by request profile and persist across restarts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-settings-')),origin='https://panel.example.test';let h=await createHostedApplication(dir,origin,false);
 try{
  await h.accounts.createUser('ruslan','owner','Owner','profile-settings-password');
  const base={host:'panel.example.test',origin};
  const login=await h.app.inject({method:'POST',url:'/api/v1/auth/login',headers:base,payload:{username:'owner',password:'profile-settings-password'}});
  const headers={...base,cookie:String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token':login.json().csrf};
  const get=(profile:string)=>h.app.inject({url:'/api/v1/settings',headers:{...headers,'x-stream-panel-profile':profile}});
  const defaults=(await get('ruslan')).json();
  const changed=await h.app.inject({method:'POST',url:'/api/v1/settings',headers,payload:{...defaults,regularThresholdPercent:75,minSessions:1,timezone:'UTC'}});assert.equal(changed.statusCode,200,changed.body);
  assert.equal((await get('gulnaz')).json().regularThresholdPercent,80);
  assert.equal((await h.app.inject({method:'POST',url:'/api/v1/settings',headers,payload:{minSessions:-1}})).statusCode,400);
  assert.equal((await get('ruslan')).json().regularThresholdPercent,75);
  const analytics=await h.app.inject({url:`/api/v1/analytics?from=0&to=${Date.now()}`,headers});assert.equal(analytics.statusCode,200,analytics.body);assert.equal(analytics.json().filters.regularThresholdPercent,75);assert.equal(analytics.json().filters.timezone,'UTC');
  const configuration=h.runtimes.get('ruslan')!.configuration,save=configuration.save.bind(configuration);configuration.save=async()=>{throw new Error('DISK_FAIL');};
  assert.equal((await h.app.inject({method:'POST',url:'/api/v1/settings',headers,payload:{minSessions:4}})).statusCode,500);assert.equal((await get('ruslan')).json().minSessions,1);configuration.save=save;
  await h.app.close();h=await createHostedApplication(dir,origin,false);
  assert.equal((await get('ruslan')).json().regularThresholdPercent,75);assert.equal((await get('ruslan')).json().timezone,'UTC');assert.equal((await get('gulnaz')).json().timezone,'Europe/Moscow');
 }finally{await h.app.close();await rm(dir,{recursive:true,force:true});}
});
