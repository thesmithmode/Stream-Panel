import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Configuration} from '../src/config.js';import {createApplication} from '../src/server.js';
import {StreamStore} from '../../../packages/core/src/store.js';
test('confirmed Moscow timezone migrates both hosted profiles and repairs historical tips before collection, preserving credentials and future explicit settings',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-da-moscow-')),path=join(dir,'shared.sqlite'),at=Date.UTC(2026,9,12,18);
 try{
 for(const profile of ['ruslan','gulnaz']){
  const config=new Configuration(join(dir,profile));await config.load();config.value.daAccessToken='saved-access';config.value.daRefreshToken='saved-refresh';await config.save();
  const store=new StreamStore(path,profile);try{const sid=store.startSession('owner','live',at,'platform',at);store.endSession(sid,at+3600000);store.ingest({source:'donationalerts',accountId:'da',externalId:'1',type:'donation',actor:null,occurredAtMs:null,receivedAtMs:at,sourceTime:'2026-10-12 21:01:00',timeQuality:'unknown',transport:'rest',payload:{amountMinor:'10000',currency:'RUB'}});}finally{store.close();}
 }
 for(const profile of ['ruslan','gulnaz']){
  const a=await createApplication(join(dir,profile),47831,false,{}, {databasePath:path,profile});try{
   assert.equal(a.configuration.value.daUtcOffsetMinutes,180);
   const saved=JSON.parse(await readFile(join(dir,profile,'secrets.json'),'utf8'));assert.equal(saved.daMoscowTimeConfirmed,true);assert.equal(saved.daAccessToken,'saved-access');assert.equal(saved.daRefreshToken,'saved-refresh');
   const sessions=await a.db.call<any[]>('sessions');assert.equal(sessions[0].donationCount,1);assert.equal(sessions[0].donationTotals.RUB,'10000');assert.equal((await a.db.call<any>('summary',sessions[0].id)).totals.RUB,'10000');assert.equal((await a.db.call<any>('donations')).items[0].occurredAtMs,at+60000);
   if(profile==='ruslan'){a.configuration.value.daUtcOffsetMinutes=0;await a.configuration.save();}
  }finally{await a.app.close();}
 }
 const a=await createApplication(join(dir,'ruslan'),47831,false,{}, {databasePath:path,profile:'ruslan'});try{assert.equal(a.configuration.value.daUtcOffsetMinutes,0,'later explicit changes survive restart');}finally{await a.app.close();}
 const other=new Configuration(join(dir,'gulnaz'));await other.load();assert.equal(other.value.daUtcOffsetMinutes,180);
 }finally{await rm(dir,{recursive:true,force:true});}
});
