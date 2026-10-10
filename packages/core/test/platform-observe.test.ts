import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';

test('YouTube alone creates a real provider session, repeats and closed links never reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-observe-yt-'));
 const path=join(dir,'data.sqlite');
 let store=new StreamStore(path);
 try {
  const id=store.observePlatformStream('youtube','channel-id','video-id',1000,1100,'https://www.youtube.com/watch?v=video-id','YouTube stream');
  assert.ok(id);
  assert.equal(store.activeLogicalStream()?.id,id);
  let sessions=store.sessions();
  assert.equal(sessions.length,1);
  assert.equal(sessions[0]!.account_id,'channel-id');
  assert.equal(sessions[0]!.stream_id,'youtube:video-id');
  assert.equal(sessions[0]!.recording_started_at_ms,1100);
  assert.equal(store.platformStreams(id!).length,1);
  assert.equal(store.platformStreams(id!)[0]!.platform,'youtube');

  assert.equal(store.observePlatformStream('youtube','channel-id','video-id',1000,1200,'https://youtube.com/watch?v=video-id','Updated'),id);
  assert.equal(store.observePlatformStream('youtube','channel-id','video-id',900,1250,'https://youtube.com/watch?v=video-id','Older start report'),id);
  assert.equal((store.sessions()[0] as {started_at_ms:number}).started_at_ms,1000);
  assert.equal(store.sessions().length,1);
  assert.equal(store.platformStreams(id!).length,1);
  store.close();

  store=new StreamStore(path);
  assert.equal(store.observePlatformStream('youtube','channel-id','video-id',1000,1300,'https://youtube.com/watch?v=video-id','After restart'),id);
  store.endSession(id!,1400);
  assert.equal(store.observePlatformStream('youtube','channel-id','video-id',1000,1500,'https://youtube.com/watch?v=video-id','Stale response'),null);
  sessions=store.sessions();
  assert.equal(sessions.length,1);
  assert.equal(sessions[0]!.ended_at_ms,1400);
  assert.equal(store.platformStreams(id!).length,1);
  assert.equal(store.platformStreams(id!)[0]!.ended_at_ms,1400);
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('Twitch and YouTube observations in either order share one eligible logical session',async()=>{
 for(const first of ['twitch','youtube'] as const) {
  const dir=await mkdtemp(join(tmpdir(),`sp-platform-observe-${first}-`));
  const store=new StreamStore(join(dir,'data.sqlite'));
  try {
   const order=first==='twitch'?['twitch','youtube'] as const:['youtube','twitch'] as const;
   let sessionId:string|null=null;
   for(const platform of order) {
    const id=platform==='twitch'
     ? store.observePlatformStream('twitch','twitch-account','twitch-stream',1000,1100,'https://www.twitch.tv/channel','Twitch')
     : store.observePlatformStream('youtube','youtube-channel','youtube-video',1050,1200,'https://www.youtube.com/watch?v=youtube-video','YouTube');
    assert.ok(id);
    if(sessionId===null) sessionId=id;
    else assert.equal(id,sessionId);
   }
   assert.equal(store.sessions().length,1);
   assert.equal((store.sessions()[0] as {started_at_ms:number}).started_at_ms,1000);
   assert.equal(store.platformStreams(sessionId!).length,2);
   assert.deepEqual(store.platformStreams(sessionId!).map(row=>row.platform),['twitch','youtube']);
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
 }
});

test('observe does not force-close manual sessions and creates a separate session when the logical window does not fit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-observe-boundaries-'));
 const store=new StreamStore(join(dir,'data.sqlite'));
 try {
  const manual=store.startSession('channel-id','manual',1000,'manual',1100);
  assert.equal(store.observePlatformStream('youtube','channel-id','video',1200,1300,null,''),null);
  assert.equal((store.sessions().find(row=>row.id===manual) as {ended_at_ms:number|null}).ended_at_ms,null);
  assert.equal(store.platformStreams(manual).length,0);

  const logical=store.observePlatformStream('twitch','other-account','first-stream',2000,2100,null,'');
  assert.ok(logical);
  const separate=store.observePlatformStream('youtube','third-account','older-video',1500,1900,null,'');
  assert.ok(separate);
  assert.notEqual(separate,logical);
  assert.equal(store.sessions().length,3);
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('observe backfills only unassigned account events and donation alerts inside recording window',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-observe-events-'));
 const path=join(dir,'data.sqlite');
 const store=new StreamStore(path);
 try {
  const session=store.startSession('twitch-account','live-stream',1000,'platform',1100);
  const manual=store.startSession('manual-account','manual-stream',1140,'manual',1140);
  store.endSession(manual,1160);
  const db=new Database(path);
  try {
   const insert=db.prepare(`INSERT INTO events
    (id,source,account_id,external_id,type,identity_id,occurred_at_ms,received_at_ms,source_time,time_quality,transport,payload_json)
    VALUES (?,?,?,?,?,NULL,?,?,NULL,'provider','rest','{}')`);
   insert.run('before-recording','twitch','twitch-account','before','chat.message',1050,1150);
   insert.run('twitch-match','twitch','twitch-account','match','chat.message',1100,1150);
   insert.run('twitch-other','twitch','other-account','other','chat.message',1150,1150);
   insert.run('donation-match','donationalerts','recipient','donation','donation',1200,1250);
   insert.run('already-manual','donationalerts','recipient','manual-donation','donation',1150,1150);
   db.prepare('INSERT INTO event_sessions VALUES (?,?)').run('already-manual',manual);
  } finally {db.close();}

  assert.equal(store.observePlatformStream('youtube','youtube-channel','video',1050,1300,null,'Stream'),session);
  const check=new Database(path);
  try {
   const assigned=check.prepare('SELECT event_id,session_id FROM event_sessions ORDER BY event_id').all() as {event_id:string;session_id:string}[];
   assert.deepEqual(assigned,[
    {event_id:'already-manual',session_id:manual},
    {event_id:'donation-match',session_id:session},
    {event_id:'twitch-match',session_id:session},
   ]);
  } finally {check.close();}
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('observe method state stays isolated by profile',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-observe-profiles-'));
 const path=join(dir,'data.sqlite');
 const ruslan=new StreamStore(path,'ruslan'),gulnaz=new StreamStore(path,'gulnaz');
 try {
  const ruslanId=ruslan.observePlatformStream('youtube','channel','video',1000,1100,null,'Ruslan');
  const gulnazId=gulnaz.observePlatformStream('youtube','channel','video',1000,1100,null,'Gulnaz');
  assert.ok(ruslanId&&gulnazId);
  assert.notEqual(ruslanId,gulnazId);
  assert.equal(ruslan.platformStreams(ruslanId).length,1);
  assert.equal(gulnaz.platformStreams(gulnazId).length,1);
 } finally {ruslan.close();gulnaz.close();await rm(dir,{recursive:true,force:true});}
});
