import test from 'node:test';
import assert from 'node:assert/strict';
import type {Configuration} from '../src/config.js';
import type {StoreClient} from '../src/db.js';
import {TwitchConnection} from '../src/twitch.js';

function fixture(request:typeof fetch) {
 const config={value:{twitchClientId:'client123',twitch:{access:'old-access',refresh:'keep-refresh',expiresAt:Date.now()+3600000,userId:'owner',scopes:['user:read:chat']},excludedBotLogins:[]},save:async()=>{}} as unknown as Configuration;
 const db={call:async()=>null} as unknown as StoreClient;
 return {connection:new TwitchConnection(config,db,request),config};
}

test('Twitch API retries one 401 after refreshing while retaining an omitted refresh token',async()=>{
 let validations=0;
  const {connection,config}=fixture((async input=>{
  if(String(input).endsWith('/token')) return Response.json({access_token:'new-access',expires_in:3600});
  validations++;
  return validations===1?Response.json({message:'expired'},{status:401}):Response.json({data:['ok']});
  }) as typeof fetch);
 try {
  assert.deepEqual(await connection.api('streams'),{data:['ok']});
  assert.equal(config.value.twitch?.access,'new-access');
  assert.equal(config.value.twitch?.refresh,'keep-refresh');
  assert.equal(validations,2);
 } finally {await connection.stop();}
});

test('Twitch transient refresh errors retain credentials and rate limits block repeat requests',async()=>{
 let requests=0;
  const {connection,config}=fixture((async()=>{requests++;return new Response('<html>',{status:503});}) as typeof fetch);
 try {
  await assert.rejects(connection.refresh(),/TWITCH_REFRESH_HTTP_503/);
  assert.equal(config.value.twitch?.refresh,'keep-refresh');
  assert.equal(requests,1);
 } finally {await connection.stop();}

 let rateRequests=0;
 const live=fixture((async()=>{rateRequests++;return new Response('{}',{status:429,headers:{'ratelimit-reset':'invalid'}});}) as typeof fetch);
 try {
  await assert.rejects(live.connection.api('streams'),/TWITCH_RATE_LIMIT_UNTIL_/);
  await assert.rejects(live.connection.api('streams'),/TWITCH_RATE_LIMIT_UNTIL_/);
  assert.equal(rateRequests,1);
 } finally {await live.connection.stop();}
});

test('Twitch definitive refresh failure clears credentials and reports reauthorization',async()=>{
 const revoked=fixture(async()=>Response.json({error:'invalid_grant'},{status:400}));
 try {
  await assert.rejects(revoked.connection.refresh(),/TWITCH_REAUTH_REQUIRED/);
  assert.equal(revoked.config.value.twitch,undefined);
  assert.equal(revoked.connection.status.state,'error');
 } finally {await revoked.connection.stop();}
});

test('Twitch validation requires matching identity and chat scope, then records owner once',async()=>{
 const ownerCalls:string[]=[];
 const config={value:{twitchClientId:'client123',twitch:{access:'access',refresh:'refresh',expiresAt:Date.now()+3600000,userId:'',scopes:[]},excludedBotLogins:[]},save:async()=>{}} as unknown as Configuration;
 const db={call:async(method:string,...args:unknown[])=>{ownerCalls.push(`${method}:${args[2]}`);return null;}} as unknown as StoreClient;
 let body={client_id:'client123',user_id:'owner',login:'',scopes:['user:read:chat']};
 const connection=new TwitchConnection(config,db,async()=>Response.json(body));
 try {
  await (connection as any).validate();
  await (connection as any).validate();
  assert.deepEqual(ownerCalls,['ensureOwnerIdentity:owner','ensureOwnerIdentity:owner']);
  assert.equal(config.value.twitch?.userId,'owner');
  body={...body,scopes:[]};
  await assert.rejects((connection as any).validate(),/MISSING_CHAT_SCOPE/);
  body={...body,client_id:'other'};
  await assert.rejects((connection as any).validate(),/TWITCH_TOKEN_MISMATCH/);
 } finally {await connection.stop();}
});

test('Twitch device auth validates response and keeps auth pending when polling is still pending',async()=>{
 const invalid=fixture(async()=>Response.json({message:'denied'},{status:400}));
 try {await assert.rejects(invalid.connection.beginAuth('client123',false),/TWITCH_DEVICE_HTTP_400/);}
 finally {await invalid.connection.stop();}

 const missing=fixture(async()=>Response.json({user_code:'ABCD'}));
 try {await assert.rejects(missing.connection.beginAuth('client123',false),/INVALID_DEVICE_RESPONSE/);}
 finally {await missing.connection.stop();}
});

test('cancelled Twitch 401 responses never refresh credentials and periodic failures cannot restore obsolete status',async(t)=>{
 for(const operation of ['api','validate']){
  let connection:TwitchConnection,calls=0;
  const f=fixture(async()=>{calls++;await connection.stop();return Response.json({},{status:401});});connection=f.connection;
  try{await assert.rejects(operation==='api'?connection.api('streams'):(connection as any).validate(),/TWITCH_AUTH_CANCELLED/);assert.equal(calls,1);assert.equal(f.config.value.twitch?.access,'old-access');}finally{await connection.stop();}
 }
 for(const operation of ['api','validate'])for(const phase of ['expired','401']){
  let calls=0;const f=fixture(async()=>{calls++;return Response.json({},{status:401});});const runtime=f.connection as any;
  if(phase==='expired')f.config.value.twitch!.expiresAt=0;
  runtime.refresh=async()=>{await f.connection.stop();};
  try{await assert.rejects(operation==='api'?f.connection.api('streams'):runtime.validate(),/TWITCH_AUTH_CANCELLED/);assert.equal(calls,phase==='expired'?0:1);}finally{await f.connection.stop();}
 }
 const {EventEmitter}=await import('node:events');
 let hourly:(()=>void)|undefined;const original=setInterval;
 t.mock.method(globalThis,'setInterval',((callback:any,interval:number,...args:any[])=>{if(interval===3600000)hourly=callback;return original(callback,interval,...args);}) as typeof setInterval);
 const config={value:{twitchClientId:'client123',twitch:{access:'fixture',refresh:'r',expiresAt:Date.now()+3600000,userId:'owner',scopes:[]},excludedBotLogins:[]},save:async()=>{}} as unknown as Configuration;
 const socket=new EventEmitter() as any;socket.close=()=>socket.emit('close');socket.terminate=()=>{};
 const db={call:async()=>null} as unknown as StoreClient;
 const c=new TwitchConnection(config,db,async()=>Response.json({client_id:'client123',user_id:'owner',login:'owner',scopes:['user:read:chat']}),()=>socket);const runtime=c as any;runtime.reconcile=async()=>{};
 try{
  await c.start();assert.ok(hourly);
  runtime.validate=async()=>{throw new Error('current validation failure');};hourly!();for(let n=0;n<3;n++)await new Promise(r=>setImmediate(r));assert.equal(c.status.detail,'current validation failure');
  const prior=JSON.stringify(c.status);runtime.validate=async()=>{await c.stop();throw new Error('obsolete failure');};hourly!();for(let n=0;n<3;n++)await new Promise(r=>setImmediate(r));assert.equal(JSON.stringify(c.status),prior);
  runtime.stopped=false;runtime.report(new Error('retired generation'),runtime.authGeneration-1);assert.equal(JSON.stringify(c.status),prior);
 }finally{await c.stop();}
});
