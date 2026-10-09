import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StreamStore} from '../src/store.js';

const update=(store:StreamStore,id:string,at:number,category:string,account='twitch-account')=>store.ingest({source:'twitch',accountId:account,externalId:id,type:'channel.update',actor:null,occurredAtMs:at,receivedAtMs:at,sourceTime:new Date(at).toISOString(),timeQuality:'provider',transport:'eventsub',payload:{categoryId:category,categoryName:category.toUpperCase(),title:`Title ${category}`}});

test('late Twitch detection restores confirmed category changes without inventing viewers or stealing event assignment',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-category-backfill-')),path=join(dir,'data.sqlite');
 const store=new StreamStore(path),db=new Database(path);
 try {
  const session=store.observePlatformStream('youtube','youtube-account','video',1000,1000,null,'YouTube')!;
  update(store,'before-start',900,'old');update(store,'wow-change',1100,'wow');update(store,'dota-change',1200,'dota');
  update(store,'future',2100,'future');update(store,'other-account',1300,'other','other-account');
  store.streamSample(session,1200,'','','',15);store.youtubeViewers(1200,20,session);
  assert.equal(store.observePlatformStream('twitch','twitch-account','stream',1000,2000,null,'Twitch'),session);
  const rows=db.prepare('SELECT observed_at_ms,category_id,category_name,title,twitch_viewers,youtube_viewers FROM stream_samples WHERE session_id=? ORDER BY observed_at_ms').all(session);
  assert.deepEqual(rows,[
   {observed_at_ms:1100,category_id:'wow',category_name:'WOW',title:'Title wow',twitch_viewers:null,youtube_viewers:null},
   {observed_at_ms:1200,category_id:'dota',category_name:'DOTA',title:'Title dota',twitch_viewers:15,youtube_viewers:20},
  ]);
  assert.equal(store.observePlatformStream('twitch','twitch-account','stream',1000,2000,null,'Twitch'),session);
  assert.deepEqual(db.prepare('SELECT * FROM stream_samples WHERE session_id=? ORDER BY observed_at_ms').all(session).length,2);
  const categories=store.analytics({fromMs:1000,toMs:2000}).categories.map(row=>row.id);
  assert.deepEqual(new Set(categories),new Set(['','wow','dota']),'the interval before the first confirmed category remains unknown');
  assert.equal(store.events().filter(row=>row.type==='channel.update').length,5,'all original raw events remain available');
 }finally{db.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('category backfill never repurposes an event belonging to a manual recording',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-category-backfill-manual-')),path=join(dir,'data.sqlite');
 const store=new StreamStore(path),db=new Database(path);
 try {
  const manual=store.startSession('twitch-account','manual',500,'manual',500);
  update(store,'manual-change',1500,'manual-category');store.endSession(manual,3000);
  const session=store.observePlatformStream('twitch','twitch-account','stream',1000,4000,null,'Twitch')!;
  assert.ok(session);
  assert.deepEqual(db.prepare('SELECT * FROM stream_samples WHERE session_id=?').all(session),[]);
  assert.equal(store.events(manual).filter(row=>row.type==='channel.update').length,1);
 }finally{db.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('confirmed categories before first recording do not fabricate event or presence coverage',()=>{
 const store=new StreamStore(':memory:');
 try {
  update(store,'known-change',1100,'wow');
  const session=store.observePlatformStream('twitch','twitch-account','stream',1000,2000,null,'Twitch')!;
  assert.equal(store.sessions()[0]!.recording_started_at_ms,2000);
  assert.deepEqual(store.events(session),[],'raw facts before recording are not falsely assigned as recorded events');
  const result=store.analytics({fromMs:1000,toMs:3000});
  assert.ok(result.categories.some(row=>row.id==='wow'));
  assert.ok(result.categories.some(row=>row.id===''));
  assert.equal(result.summary.entities,0);
  assert.equal(result.summary.messages,0);
  assert.ok(result.timeline.every(row=>row.twitchViewers===null&&row.youtubeViewers===null));
 }finally{store.close();}
});

test('category reconstruction stays profile-scoped with identical provider IDs after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-category-backfill-profiles-')),path=join(dir,'data.sqlite');
 let stores=['ruslan','gulnaz'].map(profile=>new StreamStore(path,profile));
 try {
  for(const [index,store] of stores.entries())update(store,'same-update',1100,index===0?'wow':'dota');
  for(const store of stores)store.observePlatformStream('twitch','twitch-account','same-stream',1000,2000,null,'Twitch');
  for(const store of stores)store.close();
  stores=['ruslan','gulnaz'].map(profile=>new StreamStore(path,profile));
  for(const [index,store] of stores.entries()){
   store.observePlatformStream('twitch','twitch-account','same-stream',1000,2500,null,'Twitch');
   const ids=store.analytics({fromMs:1000,toMs:3000}).categories.map(row=>row.id);
   assert.deepEqual(new Set(ids),new Set(['',index===0?'wow':'dota']));
   assert.equal(store.events().filter(row=>row.type==='channel.update').length,1);
  }
 }finally{for(const store of stores)store.close();await rm(dir,{recursive:true,force:true});}
});
