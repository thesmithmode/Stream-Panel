import test from 'node:test';
import assert from 'node:assert/strict';
import type {Configuration} from '../src/config.js';
import type {StoreClient} from '../src/db.js';
import {TwitchConnection} from '../src/twitch.js';

for(const target of ['observePlatformStream','streamSample','platformMissing','activeLogicalStream','platformStreams','recordPoll','updateChatterNames','request:chatters']) {
 test(`Twitch cancellation after ${target} prevents further writes and status recovery`,async()=>{
  const offline=['platformMissing','activeLogicalStream','platformStreams'].includes(target);
  const config={value:{twitchClientId:'client123',twitch:{userId:'owner',access:'fixture',refresh:'fixture',expiresAt:Date.now()+3600000,scopes:['moderator:read:chatters']}},save:async()=>{}} as unknown as Configuration;
  let connection:TwitchConnection,stopped=false,hit=false;const after:string[]=[];
  const stop=async(key:string)=>{if(key===target){hit=true;await connection.stop();stopped=true;}};
  const db={call:async(method:string)=>{
   if(stopped)after.push(method);await stop(method);
   if(method==='observePlatformStream')return 'logical';
   if(method==='activeLogicalStream')return {id:'logical'};
   if(method==='platformStreams')return [{platform:'twitch',account_id:'owner',ended_at_ms:null}];
   return null;
  }} as unknown as StoreClient;
  const request:typeof fetch=async input=>{
   const url=String(input);if(stopped)after.push(`request:${url}`);
   if(url.includes('chat/chatters')){await stop('request:chatters');return Response.json({data:[{user_id:'visitor',user_name:'Visitor'}],pagination:{}});}
   return Response.json({data:offline?[]:[{id:'live',user_id:'owner',started_at:new Date(Date.now()-60000).toISOString(),title:'Live',viewer_count:12}]});
  };
  connection=new TwitchConnection(config,db,request);
  const runtime=connection as unknown as {stopped:boolean;reconcile():Promise<void>};runtime.stopped=false;
  try{
   await runtime.reconcile();assert.equal(hit,true);assert.deepEqual(after,[]);
   assert.notEqual(connection.status.state,'connected');assert.equal(connection.status.capabilities.presence,undefined);
  }finally{await connection.stop();}
 });
}

test('Twitch database failure while storing a poll records a gap, preserves the live stream and next poll recovers',async()=>{
 const config={value:{twitchClientId:'client123',twitch:{userId:'owner',access:'fixture',refresh:'fixture',expiresAt:Date.now()+3600000,scopes:['moderator:read:chatters']}},save:async()=>{}} as unknown as Configuration;
 const calls:{method:string;args:unknown[]}[]=[];let fail=true;
 const db={call:async(method:string,...args:unknown[])=>{
  calls.push({method,args});if(method==='observePlatformStream')return 'logical';if(method==='recordPoll'&&fail)throw new Error('SQLITE_BUSY');return null;
 }} as unknown as StoreClient;
 const request:typeof fetch=async input=>Response.json(String(input).includes('chat/chatters')?{data:[{user_id:'visitor',user_name:'Visitor'}],pagination:{}}:{data:[{id:'live',started_at:new Date(Date.now()-60000).toISOString()}]});
 const connection=new TwitchConnection(config,db,request),runtime=connection as unknown as {stopped:boolean;reconcile():Promise<void>};runtime.stopped=false;
 try{
  await runtime.reconcile();assert.equal(connection.status.capabilities.presence,'SQLITE_BUSY');assert.equal(calls.filter(x=>x.method==='gap').length,1);assert.equal(calls.some(x=>x.method==='platformMissing'),false);
  fail=false;await runtime.reconcile();assert.equal(connection.status.capabilities.presence,'complete');assert.equal(calls.filter(x=>x.method==='gap').length,1);
 }finally{await connection.stop();}
});
