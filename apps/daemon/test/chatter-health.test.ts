import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ChatterHealth} from '../src/chatter-health.js';
import {TwitchConnection} from '../src/twitch.js';
import type {Configuration} from '../src/config.js';
import type {StoreClient} from '../src/db.js';
test('empty replies tolerate provider delay, recover with a cooldown, and reset after real observations',()=>{
 const h=new ChatterHealth();h.empty(1000);h.message(1000);
 assert.equal(h.suspect(120000),false);assert.equal(h.suspect(301000),false,'stale chat is not evidence');
 h.message(300000);assert.equal(h.suspect(301000),true);
 assert.equal(h.recover(301000),true);assert.equal(h.recover(302000),false);
 h.message(600000);assert.equal(h.recover(601000),true);
 h.populated();assert.equal(h.suspect(601000),false);
});
test('real chat notifications detect stuck empty lists and a bounded alternate sweep recovers without discarding messages',async()=>{
 const start=Date.now();let now=start,recover=false,alternate=0;
 const socket=new class extends EventEmitter{close(){this.emit('close');}terminate(){this.emit('close');}}();
 const calls:{method:string;args:any[]}[]=[];
 const config={value:{twitchClientId:'client123',twitch:{userId:'owner',access:'fixture',refresh:'fixture',expiresAt:start+3600000,scopes:['moderator:read:chatters']}},save:async()=>{}} as unknown as Configuration;
 const db={call:async(method:string,...args:any[])=>{calls.push({method,args});return method==='observePlatformStream'?'logical':null;}} as unknown as StoreClient;
 const request:typeof fetch=async input=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/chat/chatters')){
   const fallback=url.searchParams.get('first')==='100';if(fallback)alternate++;
   return Response.json({data:fallback&&recover?[{user_id:'viewer',user_name:'Viewer'}]:[],pagination:{},total:fallback&&recover?1:0});
  }
  return Response.json({data:[{id:'live',started_at:new Date(start-60000).toISOString()}]});
 };
 const connection=new TwitchConnection(config,db,request,()=>socket as any,()=>now);
 const runtime=connection as any;runtime.stopped=false;runtime.connect();
 const chat=async()=>{socket.emit('message',JSON.stringify({metadata:{message_type:'notification',message_timestamp:new Date(now).toISOString()},payload:{subscription:{type:'channel.chat.message'},event:{message_id:'m'+now,chatter_user_id:'viewer',chatter_user_name:'Viewer',message:{text:'Hello'}}}}));await new Promise(resolve=>setImmediate(resolve));};
 const latest=()=>calls.filter(c=>c.method==='recordPoll').at(-1)!.args[2];
 try{
  await runtime.reconcile();assert.equal(latest().status,'complete');
  now=start+120000;await chat();await runtime.reconcile();assert.equal(alternate,0);
  now=start+300000;await chat();await runtime.reconcile();assert.equal(latest().status,'failed');assert.equal(alternate,1);
  assert.equal(calls.filter(c=>c.method==='gap').at(-1)!.args[1],'chatters_empty_with_chat');
  now+=60000;await chat();await runtime.reconcile();assert.equal(alternate,1);
  recover=true;now=start+600000;await chat();await runtime.reconcile();
  assert.deepEqual(latest().userIds,['viewer']);assert.equal(latest().status,'complete');assert.equal(connection.status.capabilities.presence,'complete');
  assert.equal(calls.filter(c=>c.method==='ingest').length,4);
 }finally{await connection.stop();}
});
