import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {StreamStore} from '../src/store.js';
import {clockActivitySeries} from '../src/clock-activity.js';
const minute=60000,base=Date.parse('2026-10-19T06:00:00Z'); // Monday 09:00 Moscow

test('missing YouTube counters preserve known Twitch viewers through closed history, cache and reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-partial-viewers-')),path=join(dir,'db');
 let store=new StreamStore(path,'ruslan');
 try{
  const id=store.observePlatformStream('twitch','owner','twitch-stream',base,base,null,'Monday')!;
  store.observePlatformStream('youtube','channel','youtube-stream',base,base,null,'Monday');
  for(const [i,count]of [8,4,0,3].entries()){
   store.streamSample(id,base+i*minute+3000,'dota','Dota 2','Monday',count);
   store.youtubeViewers(base+i*minute+20000,i===3?0:null,id);
  }
  store.endSession(id,base+5*minute);
  const options={fromMs:base,toMs:base+5*minute,summaryOnly:true,timezone:'Europe/Moscow'};
  const report=()=>{let value=store.analytics(options);for(let n=0;value.preparing&&n<100;n++)value=store.analytics(options);assert.ok(!value.preparing);return value;};
  const check=()=>{
   const session=store.sessions()[0]!;
   assert.equal(session.viewerPeak,3); // Exact total exists only in the explicit YouTube-zero minute.
   assert.equal(session.viewerKnownPeak,8);assert.equal(session.viewerKnownMean,3.75);assert.equal(session.viewerPartial,true);
   const a=report(),h=a.hours.find(h=>h.day==='пн'&&h.hour===9)!;
   assert.equal(h.knownViewersTotal,15);assert.equal(h.knownViewerSamples,4);assert.equal(h.viewerPartialMinutes,3);
   assert.equal(h.viewersTotal,3);assert.equal(h.viewerSamples,1); // Exact aggregates remain exact.
   const known=a.streamComparison[0]!.viewers.known;
   assert.equal(known.peak,8);assert.equal(known.mean,3.75);assert.equal(known.partialMinutes,3);assert.equal(known.coverageRatio,.8);
   const b=clockActivitySeries(a.activityClock,'viewers',60,'пн',true).find(b=>b.minute===540)!;
   assert.equal(b.value,3.75);assert.equal(b.partial,true);assert.equal(b.duration,4*minute);
   assert.equal(clockActivitySeries(a.activityClock,'viewers',60,'пн').find(b=>b.minute===540)!.value,3);
   assert.equal(a.patterns.byWeekday[0]!.knownViewerSamples,4);
  };
  check();check(); // Warm/completed cache.
  store.close();store=new StreamStore(path,'ruslan');check(); // Persisted derived cache.
  const other=new StreamStore(path,'gulnaz');try{assert.equal(other.sessions().length,0);}finally{other.close();}
  const db=new Database(path,{readonly:true});try{
   assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
   assert.equal((db.prepare('SELECT count(*) AS n FROM p_ruslan_stream_samples').get() as {n:number}).n,8);
   assert.equal((db.prepare('SELECT count(*) AS n FROM p_ruslan_stream_samples WHERE youtube_viewers IS NULL').get() as {n:number}).n,7);
  }finally{db.close();}
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('entirely unknown counters stay absent, while a known zero is visible as partial zero',()=>{
 const s=new StreamStore(':memory:');try{
  const id=s.observePlatformStream('twitch','owner','live',base,base,null,'')!;
  s.observePlatformStream('youtube','channel','live',base,base,null,'');
  s.streamSample(id,base,'dota','Dota','',null);s.youtubeViewers(base+1000,null,id);
  let row=s.sessions()[0]!;assert.equal(row.viewerKnownMean,null);assert.equal(row.viewerKnownPeak,null);assert.equal(row.viewerPartial,false);
  s.streamSample(id,base,'dota','Dota','',0);s.endSession(id,base+minute);
  row=s.sessions()[0]!;assert.equal(row.viewerKnownMean,0);assert.equal(row.viewerKnownPeak,0);assert.equal(row.viewerPartial,true);assert.equal(row.viewerMean,null);
  const a=s.analytics({fromMs:base,toMs:base+minute});assert.equal(a.hours[0]!.knownViewerSamples,1);assert.equal(a.hours[0]!.knownViewersTotal,0);
 }finally{s.close();}
});
