import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import {setTimeout as delay} from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration } from '../src/config.js';
import { StoreClient } from '../src/db.js';
import { DonationAlertsConnection } from '../src/donationalerts.js';
import type { SocketFactory } from '../src/twitch.js';

test('DA automatic collection imports only current-stream donations; explicit offline import preserves older and unknown-time history', async () => {
 const dir = await mkdtemp(join(tmpdir(),'sp-da-active-'));
 const config = new Configuration(dir); await config.load();
 config.value.daAccessToken='fixture'; config.value.daUtcOffsetMinutes=0;
 const db = new StoreClient(join(dir,'data.sqlite'),'ruslan'); await db.ready;
 const now=Date.now(); let requests=0;
 const stamp=(at:number)=>new Date(at).toISOString().slice(0,19).replace('T',' ');
 const donation=(id:number,created_at:string)=>({id,amount:'1.00',currency:'RUB',username:'Viewer',message:'test',created_at});
 const rows=[donation(1,stamp(now-120000)),donation(2,stamp(now)),donation(3,stamp(now))];
 const request:typeof fetch=async input=>{
  if(String(input).endsWith('/user/oauth'))return Response.json({data:{id:7,name:'Owner',socket_connection_token:'fixture'}});
  requests++; return Response.json({data:config.value.daUtcOffsetMinutes===null?rows:rows.slice(0,2),links:{next:null}});
 };
 const socket = new EventEmitter() as any;
 socket.close=()=>socket.emit('close'); socket.send=()=>{};
 const connection = new DonationAlertsConnection(config,db,request,(()=>socket) as SocketFactory);
 try {
  await connection.start(); await setImmediate();
  assert.equal(requests,0);
  const sessionId=await db.call<string>('observePlatformStream','youtube','channel','video',now-60000,now,null,'Live');
  await connection.scanHistory(true);
  let events=await db.call<any[]>('events');
  assert.deepEqual(events.map(event=>event.external_id),['2']);
  await connection.scanHistory(true);
  assert.equal((await db.call<any>('summary')).donations,1);
  await db.call('platformMissing','youtube','channel',[],now+60000);
  await db.call('platformMissing','youtube','channel',[],now+120000);
  assert.equal(await db.call('activeLogicalStream'),null);
  const before=requests; await connection.scanHistory(true); assert.equal(requests,before);
  config.value.daUtcOffsetMinutes=null;
  await connection.scanHistory();
  events=await db.call<any[]>('events');
  assert.equal(events.length,3);
  assert.equal(events.find(event=>event.external_id==='3').occurred_at_ms,null);
  assert.equal((await db.call<any>('summary',sessionId)).donations,1);
 } finally {await connection.stop();await db.stop();await rm(dir,{recursive:true,force:true});}
});

test('DA realtime skips donations predating the active stream and deduplicates current donations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-da-realtime-'));const config=new Configuration(dir);await config.load();config.value.daAccessToken='fixture';config.value.daUtcOffsetMinutes=0;
 const db=new StoreClient(join(dir,'data.sqlite'),'ruslan');await db.ready;
 const socket=new EventEmitter() as any;socket.close=()=>socket.emit('close');socket.send=()=>{};
 const now=Date.now(),stamp=(at:number)=>new Date(at).toISOString().slice(0,19).replace('T',' ');
 const donation=(id:number,at:number)=>({data:{id,amount:'1.00',currency:'RUB',username:'Viewer',message:'test',created_at:stamp(at)}});
 const request:typeof fetch=async input=>String(input).endsWith('/user/oauth')?Response.json({data:{id:7,name:'Owner',socket_connection_token:'fixture'}}):Response.json({data:[],links:{next:null}});
 const connection=new DonationAlertsConnection(config,db,request,(()=>socket) as SocketFactory);
 try {
  await connection.start();await db.call('observePlatformStream','youtube','yt','video',now-60000,now,null,'Live');
  socket.emit('message',JSON.stringify(donation(10,now-120000)));
  socket.emit('message',JSON.stringify(donation(11,now)));
  socket.emit('message',JSON.stringify(donation(11,now)));
  for(let n=0;n<100 && !(await db.call<any[]>('events')).some(e=>e.external_id==='11');n++)await delay(10);
  assert.deepEqual((await db.call<any[]>('events')).map(e=>e.external_id),['11']);
 }finally{await connection.stop();await db.stop();await rm(dir,{recursive:true,force:true});}
});
