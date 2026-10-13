import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Configuration} from '../src/config.js';import {createApplication} from '../src/server.js';
import {StreamStore} from '../../../packages/core/src/store.js';
test('DA API clock is UTC: previously Moscow-shifted donations rejoin their streams before collection while display stays Moscow and credentials survive',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-da-api-clock-')),path=join(dir,'shared.sqlite'),at=Date.UTC(2026,9,12,8,50),payment=at+63*60000;
 try{
 for(const profile of ['ruslan','gulnaz']){
  const config=new Configuration(join(dir,profile));await config.load();config.value.daAccessToken='saved-access';config.value.daRefreshToken='saved-refresh';config.value.daUtcOffsetMinutes=180;config.value.daMoscowTimeConfirmed=true;await config.save();
  const store=new StreamStore(path,profile);try{const sid=store.startSession('owner','live',at,'platform',at);store.endSession(sid,at+260*60000);store.ingest({source:'donationalerts',accountId:'da',externalId:'1',type:'donation',actor:null,occurredAtMs:payment-180*60000,receivedAtMs:payment+1000,sourceTime:'2026-10-12 09:53:00',timeQuality:'configured',transport:'rest',payload:{amountMinor:'22800',currency:'RUB'}});assert.equal(store.sessions()[0]!.donationCount,0);}finally{store.close();}
 }
 for(const profile of ['ruslan','gulnaz']){
  const a=await createApplication(join(dir,profile),47831,false,{}, {databasePath:path,profile});try{
   assert.equal(a.configuration.value.daUtcOffsetMinutes,0);
   const saved=JSON.parse(await readFile(join(dir,profile,'secrets.json'),'utf8'));assert.equal(saved.daAccessToken,'saved-access');assert.equal(saved.daRefreshToken,'saved-refresh');
   const sessions=await a.db.call<any[]>('sessions');assert.equal(sessions[0].donationCount,1);assert.equal(sessions[0].donationTotals.RUB,'22800');assert.equal((await a.db.call<any>('summary',sessions[0].id)).totals.RUB,'22800');assert.equal((await a.db.call<any>('donations')).items[0].occurredAtMs,payment);
   if(profile==='ruslan'){a.configuration.value.daUtcOffsetMinutes=180;await a.configuration.save();}
  }finally{await a.app.close();}
 }
 const a=await createApplication(join(dir,'ruslan'),47831,false,{}, {databasePath:path,profile:'ruslan'});try{assert.equal(a.configuration.value.daUtcOffsetMinutes,0,'old display offsets must never change the provider clock');}finally{await a.app.close();}
 const other=new Configuration(join(dir,'gulnaz'));await other.load();assert.equal(other.value.daUtcOffsetMinutes,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
