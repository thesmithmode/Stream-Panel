import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {StreamStore} from '../../../packages/core/src/store.js';
import type {Configuration} from '../src/config.js';import {StoreClient} from '../src/db.js';
import {DonationAlertsConnection,normalizeDonation} from '../src/donationalerts.js';
const base=Date.parse('2026-10-10T12:00:00Z'),hour=3600000;
const stamp=(at:number)=>new Date(at).toISOString().slice(0,19).replace('T',' ');
const row=(id:number|string,at=base)=>({id,amount:'7.00',currency:'RUB',username:'Original',message:'Original donation',created_at:stamp(at)});
async function fixture(request:typeof fetch){
 const dir=await mkdtemp(join(tmpdir(),'sp-da-reimport-')),db=new StoreClient(join(dir,'data.sqlite'),'ruslan');await db.ready;
 const config={value:{daAccessToken:'fixture'},save:async()=>{}} as unknown as Configuration;
 const c=new DonationAlertsConnection(config,db,request);(c as any).stopped=false;(c as any).recipient='owner';
 return {c,db,dir,close:async()=>{await c.stop();await db.stop();await rm(dir,{recursive:true,force:true});}};
}
test('reimports skip known IDs, preserve manual edits, repair only missing timestamps and deduplicate failed rows',async()=>{
 let rows:any[]=[row(1),{...row(2),created_at:''},{...row(3),amount:'bad'}];
 const f=await fixture(async()=>Response.json({data:rows,links:{next:null}}));
 try{
  await f.c.scanHistory();assert.equal((await f.db.call<any>('summary')).donations,2);assert.equal(await f.db.call('pendingDonationImportCount','owner'),1);
  const original=(await f.db.call<any[]>('events')).find(e=>e.external_id==='1');
  const editor=new StreamStore(join(f.dir,'data.sqlite'),'ruslan');editor.updateDonation(original.id,{personId:original.person_id,amount:'9',currency:'USD',occurredAtMs:base-hour,message:'Manual edit',sourceName:'Manual'},0,base+hour);editor.close();
  const edited=await f.db.call('donation',original.id),audit=await f.db.call('donationAudit',original.id);
  let ingestions=0;const call=f.db.call.bind(f.db);f.db.call=async<T>(method:string,...args:unknown[]):Promise<T>=>{if(method==='ingest')ingestions++;return call<T>(method,...args);};
  rows=[{...row(1),amount:'not-money',username:'Changed'}, {...row(2,base+1000),amount:'999',username:'Changed'},{...row(3),amount:'bad'}];
  await f.c.scanHistory();assert.equal(ingestions,1,'known complete donation never reaches normalizer/ingest');
  assert.deepEqual(await f.db.call('donation',original.id),edited);assert.deepEqual(await f.db.call('donationAudit',original.id),audit);
  const repaired=(await f.db.call<any[]>('events')).find(e=>e.external_id==='2');
  assert.equal(repaired.occurred_at_ms,base+1000);assert.equal(repaired.source_time,stamp(base+1000));assert.equal(repaired.payload.amountMinor,'700');assert.equal(repaired.payload.actorName,'Original');
  assert.equal(await f.db.call('pendingDonationImportCount','owner'),1);
  rows=[{...row(1),amount:'not-money'},row(2,base+1000),row(3)];await f.c.scanHistory();
  assert.equal((await f.db.call<any>('summary')).donations,3);assert.equal(await f.db.call('pendingDonationImportCount','owner'),0);assert.equal(f.c.status.capabilities.history,'Импорт доступных страниц завершён');
  ingestions=0;await f.c.scanHistory();assert.equal(ingestions,0);assert.equal((await f.db.call<any>('summary')).donations,3);
 }finally{await f.close();}
});
test('automatic import checks 48 hours behind the first known donation; explicit reimport remains complete',async()=>{
 let late=false;const pages:number[]=[];
 const f=await fixture(async input=>{const page=Number(new URL(String(input)).searchParams.get('page'));pages.push(page);const data=page===1?[row(6,base+hour),row(5,base)]:page===2?[row(4,base-47*hour),row(3,base-49*hour)]:page===3?[row(2,base-60*hour)]:late?[row(1,base-100*hour)]:[];return Response.json({data,links:{next:page===4?null:'next'}});});
 try{
  await f.db.call('ingest',normalizeDonation(row(5),'owner','rest'));
  await f.c.scanHistory(true);assert.deepEqual(pages,[1,2]);assert.equal((await f.db.call<any>('summary')).donations,4);
  late=true;pages.length=0;await f.c.scanHistory();assert.deepEqual(pages,[1,2,3,4]);assert.equal((await f.db.call<any>('summary')).donations,6);
  pages.length=0;await f.c.scanHistory(true);assert.deepEqual(pages,[1,2]);assert.equal((await f.db.call<any>('summary')).donations,6);
 }finally{await f.close();}
});
test('unknown dates or non-descending responses disable automatic early stopping',async()=>{
 for(const invalid of [true,false]){
  const pages:number[]=[];const f=await fixture(async input=>{const page=Number(new URL(String(input)).searchParams.get('page'));pages.push(page);return Response.json({data:page===1?[row(1),invalid?{...row(2),created_at:'bad'}:row(2,base+hour)]:page===2?[row(3,base-72*hour)]:[row(4,base-100*hour)],links:{next:page===3?null:'next'}});});
  try{await f.db.call('ingest',normalizeDonation(row(1),'owner','rest'));await f.c.scanHistory(true);assert.deepEqual(pages,[1,2,3]);assert.equal((await f.db.call<any>('summary')).donations,4);}finally{await f.close();}
 }
});
test('pending replay preserves high-precision IDs without another provider copy',async()=>{
 const f=await fixture(async()=>Response.json({data:[],links:{next:null}}));
 try{
  await f.db.call('saveDonationImportFailure','owner','{"id":9007199254740993,"amount":0.29,"currency":"RUB","username":"Donor","created_at":"2026-10-10 12:00:00"}','LEGACY_PENDING',base);
  await f.c.scanHistory();const events=await f.db.call<any[]>('events');assert.equal(events.length,1);assert.equal(events[0].external_id,'9007199254740993');assert.equal(events[0].payload.amountMinor,'29');assert.equal(await f.db.call('pendingDonationImportCount','owner'),0);
  await f.c.scanHistory();assert.equal((await f.db.call<any>('summary')).donations,1);
 }finally{await f.close();}
});
