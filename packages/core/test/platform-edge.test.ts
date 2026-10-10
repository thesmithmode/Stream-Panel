import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';

test('platform attach and observe reject invalid references and confirmation sets',()=>{
 const store=new StreamStore(':memory:');
 try {
  assert.throws(()=>store.attachPlatformStream('', 'twitch','account','stream',1000,1100,null,'Live'),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>store.attachPlatformStream('missing', 'twitch','account','stream',1000,1100,null,'Live'),/PLATFORM_STREAM_SESSION/);
  assert.throws(()=>store.observePlatformStream('twitch','account','stream',1000,1100,null,'Live',['other']),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>store.observePlatformStream('twitch','account','stream',1000,1100,null,'Live',['stream','stream']),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>store.observePlatformStream('twitch','account','stream',1000,1100,null,'Live',[null as any]),/INVALID_PLATFORM_STREAM/);
 } finally {store.close();}
});

test('person statistics report missing sessions and safely clamp invalid session windows',()=>{
 const store=new StreamStore(':memory:');
 try {
  store.ingest({source:'twitch',accountId:'account',externalId:'message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:1000,receivedAtMs:1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hello'}});
  const person=String((store.personsTop('messages')[0] as any).id);
  assert.throws(()=>store.personStats(person,'missing'),/SESSION_NOT_FOUND/);

  const earlier=store.startSession('account','earlier',120_000,'platform',120_000);
  const raw=(store as any).db;
  raw.prepare('UPDATE sessions SET ended_at_ms=? WHERE id=?').run(60_000,earlier);
  const clamped=store.personStats(person,earlier) as any;
  assert.equal(clamped.observedMinutesThisSession,0);

  const long=store.startSession('account','long',0,'platform',0);
  raw.prepare('UPDATE sessions SET ended_at_ms=? WHERE id=?').run(40*86_400_000,long);
  const capped=store.personStats(person,long) as any;
  assert.equal(capped.observedMinutesThisSession,0);
 } finally {store.close();}
});

test('manual session deletion preserves assignment for events without provider time',()=>{
 const store=new StreamStore(':memory:');
 try {
  const session=store.startSession('account','manual',1000,'manual',1000);
  store.ingest({source:'twitch',accountId:'account',externalId:'unknown-time',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:null,receivedAtMs:1100,sourceTime:null,timeQuality:'unknown',transport:'eventsub',payload:{text:'hello'}});
  store.deleteManualSession(session,1200);
  assert.equal(store.events(session).length,0);
  assert.equal(store.events(undefined).length,1);
 } finally {store.close();}
});
