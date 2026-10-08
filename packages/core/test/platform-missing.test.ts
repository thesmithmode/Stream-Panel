import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';

test('missing links close after two distinct checks and logical session waits for every provider',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-missing-links-'));
 const path=join(dir,'data.sqlite');
 const store=new StreamStore(path);
 try {
  const session=store.startSession('twitch-account','twitch-stream',1000,'platform',1100);
  store.attachPlatformStream(session,'youtube','youtube-channel','youtube-video',1050,1100,null,'YouTube');
  const db=new Database(path);
  try {
   const insert=db.prepare(`INSERT INTO events
    (id,source,account_id,external_id,type,identity_id,occurred_at_ms,received_at_ms,source_time,time_quality,transport,payload_json)
    VALUES (?, 'twitch','twitch-account',?,'chat.message',NULL,?,1400,NULL,'provider','rest','{}')`);
   insert.run('before-end','before-end',1399);
   insert.run('at-end','at-end',1400);
   db.prepare('INSERT INTO event_sessions VALUES (?,?)').run('before-end',session);
   db.prepare('INSERT INTO event_sessions VALUES (?,?)').run('at-end',session);
  } finally {db.close();}

  store.platformMissing('twitch','twitch-account',['twitch-stream'],1200);
  assert.equal(store.platformStreams(session).find(row=>row.platform==='twitch')!.offline_checks,0);
  assert.equal(store.platformStreams(session).find(row=>row.platform==='twitch')!.last_observed_at_ms,1100);
  store.platformMissing('twitch','twitch-account',[],1200);
  store.platformMissing('twitch','twitch-account',[],1200);
  let twitch=store.platformStreams(session).find(row=>row.platform==='twitch')!;
  assert.equal(twitch.offline_checks,1);
  assert.equal(twitch.first_missing_at_ms,1200);
  assert.equal(twitch.ended_at_ms,null);
  store.platformMissing('twitch','twitch-account',[],1300);
  twitch=store.platformStreams(session).find(row=>row.platform==='twitch')!;
  assert.equal(twitch.ended_at_ms,1200);
  assert.equal(store.sessions().find(row=>row.id===session)!.ended_at_ms,null);

  store.platformMissing('youtube','youtube-channel',[],1400);
  store.platformMissing('youtube','youtube-channel',[],1500);
  const row=store.sessions().find(item=>item.id===session)!;
  assert.equal(row.ended_at_ms,1400);
  assert.equal(row.end_quality,'estimated');
  const check=new Database(path);
  try {
   const assigned=check.prepare('SELECT event_id FROM event_sessions WHERE session_id=?').all(session) as {event_id:string}[];
   assert.deepEqual(assigned.map(item=>item.event_id),['before-end']);
  } finally {check.close();}
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('missing count survives reopen and stale empty reports do not increment it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-missing-restart-'));
 const path=join(dir,'data.sqlite');
 let store=new StreamStore(path);
 try {
  const session=store.startSession('account','stream',1000,'platform',1100);
  store.platformMissing('twitch','account',[],1200);
  store.close();
  store=new StreamStore(path);
  store.platformMissing('twitch','account',[],1200);
  store.platformMissing('twitch','account',[],1150);
  const link=store.platformStreams(session)[0]!;
  assert.equal(link.offline_checks,1);
  assert.equal(link.first_missing_at_ms,1200);
  assert.equal(link.last_observed_at_ms,1200);
  store.platformMissing('twitch','account',[],1300);
  assert.equal(store.platformStreams(session)[0]!.ended_at_ms,1200);
  assert.equal(store.sessions().find(row=>row.id===session)!.ended_at_ms,1200);
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('invalid missing batches have no side effects and profiles stay isolated',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-missing-profiles-'));
 const path=join(dir,'data.sqlite');
 const ruslan=new StreamStore(path,'ruslan'),gulnaz=new StreamStore(path,'gulnaz');
 try {
  const ruslanSession=ruslan.startSession('account','stream',1000,'platform',1100);
  const gulnazSession=gulnaz.startSession('account','stream',1000,'platform',1100);
  ruslan.platformMissing('twitch','account',[],1200);
  assert.throws(()=>ruslan.platformMissing('twitch','account',['duplicate','duplicate'],1300),/INVALID_PLATFORM_MISSING/);
  assert.throws(()=>ruslan.platformMissing('twitch','account',Array.from({length:1001},(_,index)=>`id-${index}`),1300),/INVALID_PLATFORM_MISSING/);
  assert.throws(()=>ruslan.platformMissing('twitch','',[],1300),/INVALID_PLATFORM_MISSING/);
  assert.throws(()=>ruslan.platformMissing('twitch','account',[],Number.NaN),/INVALID_TIMESTAMP/);
  assert.equal(ruslan.platformStreams(ruslanSession)[0]!.offline_checks,1);
  assert.equal(ruslan.platformStreams(ruslanSession)[0]!.last_observed_at_ms,1200);
  assert.equal(gulnaz.platformStreams(gulnazSession)[0]!.offline_checks,0);
  ruslan.platformMissing('twitch','account',[],1300);
  assert.equal(ruslan.sessions().find(row=>row.id===ruslanSession)!.ended_at_ms,1200);
  assert.equal(gulnaz.sessions().find(row=>row.id===gulnazSession)!.ended_at_ms,null);
 } finally {ruslan.close();gulnaz.close();await rm(dir,{recursive:true,force:true});}
});

test('repeated or unknown end requests preserve the original end and earlier event assignments',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-end-repeat-'));
 const path=join(dir,'data.sqlite');
 const store=new StreamStore(path);
 try {
  const session=store.startSession('account','stream',1000,'platform',1100);
  const db=new Database(path);
  try {
   db.prepare(`INSERT INTO events
    (id,source,account_id,external_id,type,identity_id,occurred_at_ms,received_at_ms,source_time,time_quality,transport,payload_json)
    VALUES ('preserved','twitch','account','external','chat.message',NULL,1199,1200,NULL,'provider','rest','{}')`).run();
   db.prepare('INSERT INTO event_sessions VALUES (?,?)').run('preserved',session);
  } finally {db.close();}

  store.endSession(session,1200);
  store.endSession(session,1100);
  store.endSession('unknown-session',1100);
  const rows=store.sessions().filter(row=>row.id===session);
  assert.equal(rows[0]!.ended_at_ms,1200);
  assert.equal(rows[0]!.end_quality,'observed');
  const check=new Database(path);
  try {assert.equal((check.prepare('SELECT session_id FROM event_sessions WHERE event_id=?').get('preserved') as {session_id:string}).session_id,session);} finally {check.close();}
  assert.equal(store.platformStreams(session)[0]!.ended_at_ms,1200);
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});
