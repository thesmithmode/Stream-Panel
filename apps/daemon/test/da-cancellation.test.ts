import test from 'node:test';
import assert from 'node:assert/strict';
import type {Configuration} from '../src/config.js';
import type {StoreClient} from '../src/db.js';
import {DonationAlertsConnection} from '../src/donationalerts.js';
for(const target of ['request:history','ingest']) {
 test(`DA cancellation after ${target} never imports later rows or restores import status`,async()=>{
  const automatic=target!=='ingest';
  const config={value:{daAccessToken:'fixture',daUtcOffsetMinutes:0},save:async()=>{}} as unknown as Configuration;
  let connection:DonationAlertsConnection,stopped=false,hit=false,activeCalls=0;const after:string[]=[];
  const stop=async(key:string)=>{if(key===target){hit=true;await connection.stop();stopped=true;}};
  const db={call:async(method:string)=>{
   if(stopped)after.push(method);
   const key=method==='activeLogicalStream'?`active:${++activeCalls===1?'first':'row'}`:method;await stop(key);
   if(method==='activeLogicalStream')return {id:'live',started_at_ms:0};return {inserted:true};
  }} as unknown as StoreClient;
  const request:typeof fetch=async()=>{
   if(stopped)after.push('request:history');await stop('request:history');
   return Response.json({data:[1,2].map(id=>({id,amount:'1',currency:'RUB',created_at:'2026-10-10 07:00:00',username:'Donor'})),links:{next:null}});
  };
  connection=new DonationAlertsConnection(config,db,request);
  (connection as unknown as {stopped:boolean;recipient:string}).stopped=false;
  (connection as unknown as {recipient:string}).recipient='owner';
  try{
   await connection.scanHistory(automatic);assert.equal(hit,true);assert.deepEqual(after,[]);
   assert.notEqual(connection.status.capabilities.history,'Импорт доступных страниц завершён');assert.equal(connection.status.state,'disconnected');
  }finally{await connection.stop();}
 });
}
