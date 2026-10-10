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
