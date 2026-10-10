import test from 'node:test';
import assert from 'node:assert/strict';
import type {Configuration} from '../src/config.js';
import type {StoreClient} from '../src/db.js';
import {DonationAlertsConnection} from '../src/donationalerts.js';

function da(request:typeof fetch, values:Record<string,unknown>={}) {
 const config={value:{daAccessToken:'old-access',daRefreshToken:'keep-refresh',daClientId:'client',daClientSecret:'secret',daUtcOffsetMinutes:0,...values},save:async()=>{}} as unknown as Configuration;
 const db={call:async()=>null} as unknown as StoreClient;
 return {connection:new DonationAlertsConnection(config,db,request),config};
}

test('DA refresh requires complete credentials and preserves tokens after provider rejection',async()=>{
 let calls=0;
 const missing=da(async()=>{calls++;return Response.json({});},{daRefreshToken:'',daClientId:'',daClientSecret:''});
 try {await assert.rejects((missing.connection as any).refresh(),/DA_LOGIN_REQUIRED/);assert.equal(calls,0);}
 finally {await missing.connection.stop();}

 const denied=da(async()=>Response.json({error:'invalid_grant'},{status:401}));
 try {
  await assert.rejects((denied.connection as any).refresh(),/DA_REAUTH_REQUIRED/);
  assert.equal(denied.config.value.daAccessToken,'old-access');
  assert.equal(denied.config.value.daRefreshToken,'keep-refresh');
 } finally {await denied.connection.stop();}
});

test('DA successful refresh updates access token and keeps refresh token when omitted',async()=>{
 const state=da(async()=>Response.json({access_token:'fresh-access'}));
 try {
  await (state.connection as any).refresh();
  assert.equal(state.config.value.daAccessToken,'fresh-access');
  assert.equal(state.config.value.daRefreshToken,'keep-refresh');
 } finally {await state.connection.stop();}
});

test('DA OAuth state is single use and token exchange errors do not install credentials',async()=>{
 let requests=0;
 const state=da(async()=>{requests++;return Response.json({error:'invalid_grant'},{status:400});});
 state.config.value.daClientId='client';state.config.value.daClientSecret='secret';
 const authUrl=state.connection.authUrl('https://panel.test/callback');
 const oauthState=new URL(authUrl).searchParams.get('state')!;
 try {
  await assert.rejects(state.connection.finishAuth('code','wrong','https://panel.test/callback'),/INVALID_OAUTH_STATE/);
  await assert.rejects(state.connection.finishAuth('code',oauthState,'https://panel.test/callback'),/DA_OAUTH_HTTP_400/);
  await assert.rejects(state.connection.finishAuth('code',oauthState,'https://panel.test/callback'),/INVALID_OAUTH_STATE/);
  assert.equal(requests,1);
  assert.equal(state.config.value.daAccessToken,'old-access');
 } finally {await state.connection.stop();}
});

test('DA history reports unknown pagination and marks pages incomplete when a row cannot be stored',async()=>{
 const config={value:{daAccessToken:'access',daUtcOffsetMinutes:0},save:async()=>{}} as unknown as Configuration;
 let failIngest=false;
 const db={call:async(method:string)=>{if(method==='ingest'&&failIngest)throw new Error('SQLITE_BUSY');return {inserted:true};}} as unknown as StoreClient;
 let page:{data:unknown[];links?:{next:unknown}}={data:[]};
 const connection=new DonationAlertsConnection(config,db,async()=>Response.json(page));
 (connection as any).stopped=false;
 try {
  await assert.rejects(connection.scanHistory(),/DA_PAGINATION_UNKNOWN/);
  assert.equal(connection.status.capabilities.history,'Ошибка импорта');
  page={data:[{id:1,amount:'1',currency:'RUB',username:'Donor',created_at:'2026-10-10 07:00:00'}],links:{next:null}};
  failIngest=true;
  await connection.scanHistory();
  assert.equal(connection.status.capabilities.history,'Импорт неполный: пропущено записей 1');
 } finally {await connection.stop();}
});
