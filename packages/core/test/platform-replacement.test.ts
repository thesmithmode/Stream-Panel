import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';

test('confirmed next Twitch or YouTube stream continues the recording and retains the old provider segment',async()=>{
 for(const platform of ['twitch','youtube'] as const) {
  const dir=await mkdtemp(join(tmpdir(),`sp-platform-replace-${platform}-`));
  const path=join(dir,'data.sqlite');
  let store=new StreamStore(path);
  try {
   const account=platform==='twitch'?'twitch-account':'youtube-channel';
   const url=platform==='twitch'?'https://twitch.tv/channel':'https://youtube.com/watch?v=old-video';
   const oldId=store.observePlatformStream(platform,account,'old-stream',1000,1100,url,'Old');
   assert.ok(oldId);
   store.close();

   store=new StreamStore(path);
   const newUrl=platform==='twitch'?'https://twitch.tv/channel':'https://youtube.com/watch?v=new-video';
   const newId=store.observePlatformStream(platform,account,'new-stream',2000,2100,newUrl,'New',['new-stream']);
   assert.ok(newId);
   assert.equal(newId,oldId);
   const rows=store.sessions();
   assert.equal(rows.length,1);
   assert.equal(rows.find(row=>row.id===oldId)!.ended_at_ms,null);
   assert.equal(rows.find(row=>row.id===oldId)!.end_quality,'unknown');
   assert.equal(rows.find(row=>row.id===newId)!.ended_at_ms,null);
   assert.equal(store.platformStreams(oldId!).find(row=>row.external_id==='old-stream')!.ended_at_ms,2000);
   assert.equal(store.platformStreams(newId!).find(row=>row.external_id==='new-stream')!.ended_at_ms,null);
   assert.equal(store.observePlatformStream(platform,account,'new-stream',1900,2200,newUrl,'Same stream'),newId);
   assert.equal(store.sessions().length,1);
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
 }
});

test('a concurrent YouTube broadcast cannot close another live broadcast without complete confirmation',()=>{
 const store=new StreamStore(':memory:');
 try {
  const id=store.observePlatformStream('youtube','channel','one',1000,1100,null,'One')!;
  assert.equal(store.observePlatformStream('youtube','channel','two',1050,1200,null,'Two'),id);
  assert.equal(store.platformStreams(id).filter(link=>link.ended_at_ms===null).length,2);
  assert.equal(store.observePlatformStream('youtube','channel','three',1150,1300,null,'Three',['one','two','three']),id);
  assert.equal(store.platformStreams(id).filter(link=>link.ended_at_ms===null).length,3);
  const before=store.platformStreams(id);
  assert.throws(()=>store.observePlatformStream('youtube','channel','four',1250,1400,null,'Four',['one']),/INVALID_PLATFORM_STREAM/);
  assert.deepEqual(store.platformStreams(id),before);
 } finally {store.close();}
});

test('Twitch replacement continues a shared logical session while another provider stays open',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-replace-shared-'));
 const store=new StreamStore(join(dir,'data.sqlite'));
 try {
  const session=store.observePlatformStream('youtube','youtube-channel','youtube-video',1000,1100,'https://youtube.com/watch?v=youtube-video','YouTube');
  assert.ok(session);
  assert.equal(store.observePlatformStream('twitch','twitch-account','twitch-old',1050,1200,'https://twitch.tv/channel','Twitch old'),session);
  assert.equal(store.observePlatformStream('twitch','twitch-account','twitch-new',1300,1400,'https://twitch.tv/channel','Twitch new'),session);
  const links=store.platformStreams(session!);
  assert.equal(links.find(row=>row.external_id==='twitch-old')!.ended_at_ms,1300);
  assert.equal(links.find(row=>row.external_id==='twitch-new')!.ended_at_ms,null);
  assert.equal(links.find(row=>row.external_id==='youtube-video')!.ended_at_ms,null);
  assert.equal(store.sessions().length,1);
  assert.equal(store.sessions()[0]!.ended_at_ms,null);
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('stale new-stream response has no effect and the same external ID never replaces itself',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-platform-replace-stale-'));
 const path=join(dir,'data.sqlite');
 let store=new StreamStore(path);
 try {
  const oldId=store.observePlatformStream('twitch','account','old-stream',1000,1500,'https://twitch.tv/channel','Old');
  assert.ok(oldId);
  assert.equal(store.observePlatformStream('twitch','account','old-stream',1000,1600,'https://twitch.tv/channel','Updated'),oldId);
  store.close();

  store=new StreamStore(path);
  assert.equal(store.observePlatformStream('twitch','account','new-stream',1200,1600,'https://twitch.tv/channel','Stale'),null);
  assert.equal(store.sessions().length,1);
  const old=store.platformStreams(oldId!).find(row=>row.external_id==='old-stream')!;
  assert.equal(old.ended_at_ms,null);
  assert.equal(old.last_observed_at_ms,1600);
  const newId=store.observePlatformStream('twitch','account','new-stream',1200,1700,'https://twitch.tv/channel','Confirmed');
  assert.ok(newId);
  assert.notEqual(newId,oldId);
  assert.equal(store.sessions().length,2);
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});
