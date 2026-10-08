import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';

test('confirmed Twitch and YouTube links attach and repeated observations update monotonically',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-attach-'));
 const path=join(dir,'data.sqlite');
 let store=new StreamStore(path);
 try {
  const sessionId=store.startSession('account','logical-stream',1000,'platform',1050);
  store.attachPlatformStream(sessionId,'twitch','twitch-account','twitch-stream',1100,1200,'https://www.twitch.tv/channel','Twitch title');
  store.attachPlatformStream(sessionId,'youtube','youtube-account','youtube-stream',1150,1250,'https://www.youtube.com/watch?v=video-id','YouTube title');
  const initial=store.platformStreams(sessionId);
  assert.equal(initial.length,3); // startSession seeds the legacy Twitch link as well.
  const youtube=initial.find(row=>row.platform==='youtube')!;
  assert.equal(youtube.started_at_ms,1150);
  assert.equal(youtube.last_observed_at_ms,1250);
  assert.equal(youtube.title,'YouTube title');
  store.close();

  store=new StreamStore(path);
  const db=new Database(path);
  try {db.prepare("UPDATE platform_streams SET offline_checks=1,first_missing_at_ms=1450 WHERE platform='youtube' AND external_id='youtube-stream'").run();}
  finally {db.close();}
  store.attachPlatformStream(sessionId,'youtube','youtube-account','youtube-stream',900,1400,'https://youtube.com/watch?v=stale-video','Stale title');
  const stale=store.platformStreams(sessionId).find(row=>row.platform==='youtube')!;
  assert.equal(stale.offline_checks,1);
  assert.equal(stale.first_missing_at_ms,1450);
  assert.equal(stale.last_observed_at_ms,1250);
  assert.equal(stale.title,'YouTube title');
  store.attachPlatformStream(sessionId,'youtube','youtube-account','youtube-stream',900,1500,'https://youtube.com/watch?v=newer-video','Latest title');
  store.attachPlatformStream(sessionId,'youtube','youtube-account','youtube-stream',900,1350,'https://youtube.com/watch?v=older-video','Older title');
  const updated=store.platformStreams(sessionId).find(row=>row.platform==='youtube')!;
  assert.equal(updated.started_at_ms,1150);
  assert.equal(updated.last_observed_at_ms,1500);
  assert.equal(updated.offline_checks,0);
  assert.equal(updated.first_missing_at_ms,null);
  assert.equal(updated.url,'https://youtube.com/watch?v=newer-video');
  assert.equal(updated.title,'Latest title');
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('platform stream attach rejects invalid input, ineligible sessions, and stream key collisions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-attach-errors-'));
 const store=new StreamStore(join(dir,'data.sqlite'));
 try {
  const platformId=store.startSession('account','platform-id',1000,'platform',1050);
  const otherPlatformId=store.startSession('other-account','other-id',1000,'platform',1050);
  const manualId=store.startSession('manual-account','manual-id',1000,'manual',1050);
  const attach=(sessionId:string,platform:'twitch'|'youtube'='youtube',account='channel',external='video',started=1100,observed=1200,url:string|null='https://www.youtube.com/watch?v=video',title='Title')=>
   store.attachPlatformStream(sessionId,platform,account,external,started,observed,url,title);

  assert.throws(()=>attach('missing'),/PLATFORM_STREAM_SESSION/);
  assert.throws(()=>attach(manualId),/PLATFORM_STREAM_SESSION/);
  assert.throws(()=>attach(platformId,'video-site' as 'youtube'),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'youtube','','video'),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'youtube','channel','',1100,1200),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'youtube','channel','video',1300,1200),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'youtube','channel','video',1100,1200,'http://youtube.com/watch?v=x'),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'youtube','channel','video',1100,1200,'https://youtube.com:444/watch?v=x'),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'youtube','channel','video',1100,1200,'https://youtube.com/watch?v=x#fragment'),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'youtube','channel','video',1100,1200,'https://youtube.com.evil/watch?v=x'),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'twitch','channel','video',1100,1200,'https://www.youtube.com/watch?v=x'),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'twitch','channel','video',1100,1200,'https://twitch.tv/'),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'youtube','channel','video',1100,1200,'https://youtube.com/watch?v=x','x'.repeat(1001)),/INVALID_PLATFORM_STREAM/);
  assert.throws(()=>attach(platformId,'youtube','a'.repeat(257),'video'),/INVALID_PLATFORM_STREAM/);

  attach(platformId,'youtube','channel','shared-video');
  assert.throws(()=>attach(otherPlatformId,'youtube','channel','shared-video'),/PLATFORM_STREAM_CONFLICT/);
  store.endSession(platformId,1500);
  assert.throws(()=>attach(platformId,'youtube','channel','shared-video'),/PLATFORM_STREAM_CONFLICT/);
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('platform stream attach does not cross profile boundaries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-attach-profiles-'));
 const path=join(dir,'data.sqlite');
 const ruslan=new StreamStore(path,'ruslan'),gulnaz=new StreamStore(path,'gulnaz');
 try {
  const ruslanSession=ruslan.startSession('account','stream',1000,'platform',1050);
  assert.throws(()=>gulnaz.attachPlatformStream(ruslanSession,'youtube','channel','video',1100,1200,'https://youtube.com/watch?v=x','Title'),/PLATFORM_STREAM_SESSION/);
  const gulnazSession=gulnaz.startSession('account','stream',1000,'platform',1050);
  gulnaz.attachPlatformStream(gulnazSession,'youtube','channel','video',1100,1200,'https://youtube.com/watch?v=x','Title');
  assert.equal(ruslan.platformStreams(ruslanSession).some(row=>row.platform==='youtube'),false);
  assert.equal(gulnaz.platformStreams(gulnazSession).filter(row=>row.platform==='youtube').length,1);
 } finally {ruslan.close();gulnaz.close();await rm(dir,{recursive:true,force:true});}
});
