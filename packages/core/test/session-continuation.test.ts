import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';

test('a restart under 30 minutes preserves the recording and excludes its break from analytics',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-continuation-')),path=join(dir,'db');
 let store=new StreamStore(path);
 try {
  const first=store.observePlatformStream('twitch','owner','first',60000,60000,null,'First')!;
  store.streamSample(first,60000,'game','Game','First',4);
  store.endSession(first,180000);
  store.close();store=new StreamStore(path);
  const next=store.observePlatformStream('twitch','owner','second',600000,600000,null,'Second')!;
  assert.equal(next,first);
  store.streamSample(next,600000,'game','Game','Second',5);
  store.endSession(next,720000);
  assert.equal(store.sessions().length,1);
  assert.equal(store.sessions()[0]!.started_at_ms,60000);
  assert.equal(store.sessions()[0]!.ended_at_ms,720000);
  assert.deepEqual(store.sessions()[0]!.breaks,[{from:180000,to:600000}]);
  assert.equal(store.platformStreams(first).length,2);
  const analytics=store.analytics({fromMs:0,toMs:800000,sessionId:first});
  assert.equal(analytics.streamComparison[0]!.durationMs,240000);
  assert.deepEqual(analytics.breaks,[{session:first,from:180000,to:600000}]);
  assert.equal(analytics.timeline.find(p=>p.at===300000)?.isBreak,true);
 } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('30 minutes is a strict boundary and another account cannot extend a recording',async()=>{
 for(const [account,start,merged] of [['owner',1859999,true],['owner',1860000,false],['other',120000,false]] as const){
  const store=new StreamStore(':memory:');
  try {
   const first=store.observePlatformStream('twitch','owner','first',0,0,null,'')!;
   store.endSession(first,60000);
   const next=store.observePlatformStream('twitch',account,'second',start,start,null,'')!;
   assert.equal(next===first,merged);
  }finally{store.close();}
 }
});

test('continuing YouTube keeps the logical stream live without a break during a Twitch restart',()=>{
 const store=new StreamStore(':memory:');
 try {
  const first=store.observePlatformStream('youtube','yt','video',0,0,null,'')!;
  store.observePlatformStream('twitch','owner','first',0,1,null,'');
  assert.equal(store.observePlatformStream('twitch','owner','next',60000,60001,null,''),first);
  assert.deepEqual(store.sessions()[0]!.breaks,[]);
 }finally{store.close();}
});

test('a new provider ID after a long collector outage does not invent a zero-length break',()=>{
 const s=new StreamStore(':memory:');try{
  const first=s.observePlatformStream('twitch','owner','old',0,60000,null,'')!;
  const next=s.observePlatformStream('twitch','owner','next',31*60000,32*60000,null,'',['next'])!;
  assert.notEqual(next,first);assert.equal(s.sessions().find(row=>row.id===first)!.ended_at_ms,60000);
 }finally{s.close();}
});
