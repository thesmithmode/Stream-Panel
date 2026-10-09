import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Configuration} from '../src/config.js';
import type {StoreClient} from '../src/db.js';
import {StreamStore} from '../../../packages/core/src/store.js';
import {TwitchConnection} from '../src/twitch.js';

function makeTwitch(store:StreamStore, now:number, response:()=>Response|Promise<Response>) {
 const config={
  value:{twitchClientId:'test-client',twitch:{access:'access',refresh:'refresh',expiresAt:Date.now()+3_600_000,userId:'twitch-account',scopes:[]},excludedBotLogins:[]},
  save:async()=>{},
 } as unknown as Configuration;
 const calls:string[]=[];
 const db={call:async(method:string,...args:unknown[])=>{
  calls.push(method);
  const fn=(store as unknown as Record<string,(...values:unknown[])=>unknown>)[method];
  if(typeof fn!=='function')throw new Error('UNKNOWN_OPERATION');
  return fn.apply(store,args);
 }} as unknown as StoreClient;
 const request=(async()=>response()) as typeof fetch;
 const connection=new TwitchConnection(config,db,request,undefined,()=>now);
 (connection as unknown as {stopped:boolean}).stopped=false;
 return {connection,calls};
}

const live=(id:string,startedAtMs:number)=>({
 data:[{id,user_id:'twitch-account',user_login:'streamer',type:'live',started_at:new Date(startedAtMs).toISOString(),title:`Stream ${id}`,game_id:'game',game_name:'Game',viewer_count:10}],
});

test('Twitch reconciliation shares a live YouTube logical session and does not close it when Twitch goes offline',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-twitch-logical-shared-'));
 const store=new StreamStore(join(dir,'data.sqlite'));
 const connections:TwitchConnection[]=[];
 try {
  const logical=store.observePlatformStream('youtube','youtube-channel','youtube-video',900,1000,'https://youtube.com/watch?v=youtube-video','YouTube');
  assert.ok(logical);
  const positive=makeTwitch(store,1100,()=>Response.json(live('twitch-live',1050)));
  connections.push(positive.connection);
  await (positive.connection as unknown as {reconcile():Promise<void>}).reconcile();
  assert.equal(positive.calls.includes('startSession'),false);
  assert.equal(positive.calls.includes('observePlatformStream'),true);
  assert.equal(store.sessions().length,1);
  assert.equal(store.platformStreams(logical!).length,2);

  for(const now of [1200,1300]) {
   const offline=makeTwitch(store,now,()=>Response.json({data:[]}));
   connections.push(offline.connection);
   await (offline.connection as unknown as {reconcile():Promise<void>}).reconcile();
   assert.equal(offline.calls.includes('endSession'),false);
  }
  const session=store.sessions().find(row=>row.id===logical)!;
  assert.equal(session.ended_at_ms,null);
  const links=store.platformStreams(logical!);
  assert.equal(links.find(row=>row.platform==='twitch')!.ended_at_ms,1200);
  assert.equal(links.find(row=>row.platform==='youtube')!.ended_at_ms,null);
 } finally {for(const connection of connections)await connection.stop();store.close();await rm(dir,{recursive:true,force:true});}
});

test('Twitch errors and malformed successful bodies do not count as offline observations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-twitch-logical-errors-'));
 const store=new StreamStore(join(dir,'data.sqlite'));
 const {connection,calls}=makeTwitch(store,1100,()=>Response.json(live('twitch-live',1000)));
 try {
  await (connection as unknown as {reconcile():Promise<void>}).reconcile();
  const id=store.sessions()[0]!.id as string;
  const requestField=connection as unknown as {request:typeof fetch};
  requestField.request=(async()=>new Response('provider error',{status:503})) as typeof fetch;
  await assert.rejects((connection as unknown as {reconcile():Promise<void>}).reconcile(),/TWITCH_HTTP_503/);
  assert.equal(store.platformStreams(id)[0]!.offline_checks,0);
  assert.equal(store.platformStreams(id)[0]!.ended_at_ms,null);
  assert.equal(calls.filter(method=>method==='platformMissing').length,0);

  requestField.request=(async()=>Response.json({data:[{id:'bad',started_at:'invalid'}]})) as typeof fetch;
  await assert.rejects((connection as unknown as {reconcile():Promise<void>}).reconcile(),/INVALID_TWITCH_STREAM/);
  assert.equal(store.platformStreams(id)[0]!.offline_checks,0);
  assert.equal(store.platformStreams(id)[0]!.ended_at_ms,null);
  assert.equal(calls.filter(method=>method==='platformMissing').length,0);
 } finally {await connection.stop();store.close();await rm(dir,{recursive:true,force:true});}
});

test('Twitch restart reuses its ledger session and an open manual session is never captured',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-twitch-logical-restart-'));
 const path=join(dir,'data.sqlite');
 const store=new StreamStore(path);
 const connections:TwitchConnection[]=[];
 try {
  const first=makeTwitch(store,1100,()=>Response.json(live('twitch-live',1000)));
  connections.push(first.connection);
  await (first.connection as unknown as {reconcile():Promise<void>}).reconcile();
  const id=store.sessions()[0]!.id as string;
  const restarted=makeTwitch(store,1200,()=>Response.json(live('twitch-live',1000)));
  connections.push(restarted.connection);
  await (restarted.connection as unknown as {reconcile():Promise<void>}).reconcile();
  assert.equal(store.sessions().length,1);
  assert.equal(store.platformStreams(id).filter(row=>row.platform==='twitch').length,1);

  store.close();
  const manualStore=new StreamStore(path);
  try {
   const manual=manualStore.startSession('twitch-account','manual',1300,'manual',1300);
   const manualConnection=makeTwitch(manualStore,1400,()=>Response.json(live('manual-overlap',1350)));
   connections.push(manualConnection.connection);
   await (manualConnection.connection as unknown as {reconcile():Promise<void>}).reconcile();
   const row=manualStore.sessions().find(session=>session.id===manual)!;
   assert.equal(row.kind,'manual');
   assert.equal(row.ended_at_ms,null);
   assert.equal(manualStore.platformStreams(manual).length,0);
   assert.equal(manualConnection.calls.includes('observePlatformStream'),true);
  } finally {manualStore.close();}
 } finally {for(const connection of connections)await connection.stop();await rm(dir,{recursive:true,force:true});}
});
