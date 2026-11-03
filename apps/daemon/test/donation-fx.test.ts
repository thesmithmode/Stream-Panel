import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchCbrRates,parseCbrRates,startDonationFx} from '../src/donation-fx.js';
const xml='<ValCurs Date="30.10.2026"><Valute ID="usd"><CharCode>USD</CharCode><Nominal>1</Nominal><Value>81,1234</Value></Valute><Valute ID="kzt"><CharCode>KZT</CharCode><Nominal>100</Nominal><Value>16,5432</Value></Valute></ValCurs>';
const day='2026-10-31',result={effectiveDay:'2026-10-30',rates:[{currency:'USD',nominal:1,value:'81.1234'},{currency:'KZT',nominal:100,value:'16.5432'}]};
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
test('CBR parser uses effective day and nominal and rejects partial, malformed and future data',async()=>{
 assert.deepEqual(parseCbrRates(xml,day),result);
 for(const bad of ['',xml.replace('30.10.2026','01.11.2026'),xml.replace('30.10.2026','bad'),xml.replace('</ValCurs>',''),'<ValCurs Date="30.10.2026"></ValCurs>',xml.replace('USD','bad'),xml.replace('81,1234','NaN'),xml.replace('<Nominal>1','<Nominal>0'),xml.replace('<Nominal>1','<Nominal>9007199254740993'),xml.replace('<Nominal>1</Nominal>','')])assert.throws(()=>parseCbrRates(bad,day),/INVALID_CBR_RESPONSE/);
 const request:typeof fetch=async(url,options)=>{assert.equal(url,'https://www.cbr.ru/scripts/XML_daily.asp?date_req=31/10/2026');assert.ok(options?.signal);return new Response(xml);};
 assert.deepEqual(await fetchCbrRates(day,request),result);
 await assert.rejects(fetchCbrRates(day,async()=>new Response('',{status:503})),/CBR_UNAVAILABLE/);
 await assert.rejects(fetchCbrRates(day,async()=>new Response('x'.repeat(256001))),/INVALID_CBR_RESPONSE/);
 await assert.rejects(fetchCbrRates(day,async()=>{throw Error('timeout');}),/timeout/);
});
test('rate backfill waits for collection, persists one batch, retries failures, does not overlap and stops',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let enabled=false,errors=0,loads=0,writes=0,queries=0;
 const runtime={db:{call:async(method:string,...args:unknown[])=>{if(method==='pendingExchangeDates'){queries++;return [day];}writes++;assert.deepEqual(args.slice(0,3),[day,result.effectiveDay,result.rates]);}}};
 const stop=startDonationFx(()=>[runtime] as any,()=>enabled,()=>errors++,async()=>{loads++;if(loads===1)throw Error('offline');return result;});
 try{
  assert.equal(queries,0);enabled=true;t.mock.timers.tick(60000);await settle();assert.equal(errors,1);assert.equal(writes,0);
  t.mock.timers.tick(60000);await settle();assert.equal(writes,1);assert.equal(loads,2);
  stop();t.mock.timers.tick(120000);await settle();assert.equal(loads,2);
 }finally{stop();t.mock.timers.reset();}
});
test('shutdown during pending query or network load never writes or visits another profile',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  for(const phase of ['query','network']){
   let release!:(value:any)=>void,calls=0,loads=0;
   const runtime={db:{call:async()=>{calls++;if(phase==='query')return new Promise(resolve=>release=resolve);return [day,day];}}};
   const stop=startDonationFx(()=>[runtime,runtime] as any,()=>true,()=>assert.fail('error'),async()=>{loads++;return new Promise(resolve=>release=resolve);});
   await settle();t.mock.timers.tick(120000);assert.equal(calls,1);stop();release(phase==='query'?[day]:result);await settle();assert.equal(calls,1);assert.equal(loads,phase==='query'?0:1);
  }
 }finally{t.mock.timers.reset();}
});
