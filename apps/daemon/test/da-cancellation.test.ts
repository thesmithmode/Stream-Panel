import test from 'node:test';
import assert from 'node:assert/strict';
import type {Configuration} from '../src/config.js';
import type {StoreClient} from '../src/db.js';
import {DonationAlertsConnection} from '../src/donationalerts.js';
for(const target of ['request:history','providerSnapshot','ingest']) {
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

test('DA realtime keeps untimed donations, archives malformed rows and stops at every asynchronous boundary',async()=>{
 const {EventEmitter}=await import('node:events');
 for(const mode of ['untimed-active','untimed-offline','malformed','snapshot-stop','active-stop','ingest-stop','snapshot-generation','active-generation','ingest-generation','late-error']){
  const writes:string[]=[];const config={value:{daAccessToken:'fixture',daUtcOffsetMinutes:null},save:async()=>{}} as unknown as Configuration;
  let connection:DonationAlertsConnection;
  const socket=new EventEmitter() as any;socket.close=()=>socket.emit('close');socket.terminate=()=>{};socket.send=()=>{};
  const targets:Record<string,string>={snapshot:'providerSnapshot',active:'activeLogicalStream',ingest:'ingestLiveDonation'};
  const db={call:async(method:string)=>{
   writes.push(method);const [phase,action]=mode.split('-');
   if(method===targets[phase!]){
    if(action==='stop')await connection.stop();
    if(action==='generation')(connection as any).generation++;
   }
   if(mode==='late-error'){await connection.stop();throw new Error('obsolete failure');}
   if(method==='activeLogicalStream')return mode==='untimed-offline'?null:{id:'live',started_at_ms:0};return {inserted:true};
  }} as unknown as StoreClient;
  connection=new DonationAlertsConnection(config,db,async()=>{assert.fail('no HTTP request for a donation publication');},()=>socket);
  const runtime=connection as any;runtime.stopped=false;runtime.recipient='owner';runtime.connect('transport-token',runtime.generation);
  try{
   socket.emit('message',JSON.stringify({data:{id:1,amount:mode==='malformed'?'bad':'1',currency:'RUB',created_at:'2026-10-11 07:00:00',username:'Donor',future_field:'retained'}}));
   for(let n=0;n<5;n++)await new Promise(r=>setImmediate(r));
   if(mode==='untimed-active')assert.deepEqual(writes,['providerSnapshot','activeLogicalStream','ingestLiveDonation']);
   if(mode==='untimed-offline')assert.deepEqual(writes,['providerSnapshot','activeLogicalStream','ingest']);
   if(mode==='malformed'||mode.startsWith('snapshot-')||mode==='late-error')assert.deepEqual(writes,['providerSnapshot']);
   if(mode.startsWith('active-'))assert.deepEqual(writes,['providerSnapshot','activeLogicalStream']);
   if(mode.startsWith('ingest-'))assert.equal(writes.at(-1),'ingestLiveDonation');
   if(mode.endsWith('-stop')||mode==='late-error')assert.equal(connection.status.state,'disconnected');
   if(mode.includes('generation')||mode.endsWith('-stop')||mode==='late-error')assert.equal(connection.status.lastEventAt,undefined);
  }finally{await connection.stop();}
 }
});
