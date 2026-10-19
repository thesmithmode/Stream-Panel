import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';
import {AnalyticsReportCache} from '../src/analytics-report-cache.js';
import {AnalyticsWorkspace} from '../src/analytics-workspace.js';
import {AnalyticsHistory} from '../src/analytics-history.js';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const key=(n:number)=>n.toString(16).padStart(64,'0');

test('low disk skips projection writes and recovery persists them without touching source facts',t=>{
 const dir=mkdtempSync(join(tmpdir(),'analytics-low-disk-')),path=join(dir,'data.sqlite'),s=new StreamStore(path),db=(s as any).db,w=new AnalyticsWorkspace(db),cache=new AnalyticsReportCache(db);
 try{
  s.startSession('owner','retained',1,'platform',1);
  const actual=fs.statfsSync(path);t.mock.method(fs,'statfsSync',()=>({...actual,bavail:0}));syncBuiltinESMExports();
  assert.equal(cache.save(key(1),key(1),{version:1},w),false);assert.equal(cache.get(key(1)),undefined);assert.equal(s.sessions().length,1);
  t.mock.restoreAll();syncBuiltinESMExports();assert.equal(cache.save(key(1),key(1),{version:1},w),true);assert.deepEqual(cache.get(key(1)),{version:1});
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();w.dispose();s.close();rmSync(dir,{recursive:true,force:true});}
});

test('durable projections and exact membership survive reopen with identical keys isolated by profile',()=>{
 const dir=mkdtempSync(join(tmpdir(),'analytics-projection-')),path=join(dir,'data.sqlite');
 try{
  for(const profile of ['ruslan','gulnaz']){
   const s=new StreamStore(path,profile),db=(s as any).db,w=new AnalyticsWorkspace<{name:string}>(db);
   try{w.people.set('same-person',{name:profile});w.addClock('same-stream',[{day:'пн',resolution:1,minute:60,streams:1,airtimeMs:60000,personTimeMs:60000,averageAudience:1,people:[{id:'same-person',visits:1}]}]);
    assert.equal(new AnalyticsReportCache(db).save(key(1),key(1),{profile},w),true);
   }finally{w.dispose();s.close();}
  }
  for(const profile of ['ruslan','gulnaz']){
   const s=new StreamStore(path,profile),db=(s as any).db,w=new AnalyticsWorkspace<{name:string}>(db,key(1));
   try{assert.deepEqual(new AnalyticsReportCache(db).get(key(1)),{profile});assert.deepEqual(w.people.get('same-person'),{name:profile});assert.equal(w.clockPage('пн',60,1).total,1);assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');}
   finally{w.dispose();s.close();}
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('report eviction bounds entries and bytes, cascades membership, and never changes source facts',()=>{
 const s=new StreamStore(':memory:'),db=(s as any).db,w=new AnalyticsWorkspace<{name:string}>(db);
 try{
  s.startSession('owner','retained',1,'platform',1);w.people.set('person',{name:'Retained'});
  const cache=new AnalyticsReportCache(db,4096);
  for(let n=0;n<40;n++)assert.equal(cache.save(key(n),key(n),{n},w),true);
  const retained=db.prepare('SELECT count(*) n,coalesce(sum(bytes),0) bytes FROM analytics_reports').get();assert.ok(retained.n<=32);assert.ok(retained.bytes<=4096);
  assert.equal(db.prepare('SELECT count(*) n FROM analytics_report_people').get().n,retained.n);
  assert.equal(cache.get(key(0)),undefined);assert.deepEqual(cache.get(key(39)),{n:39});
  const bounded=new AnalyticsReportCache(db,1);assert.equal(bounded.save(key(100),key(100),{},w),false);
  assert.equal(new AnalyticsReportCache(db,0).get(key(39)),undefined);
  assert.equal(cache.save(key(101),key(101),'x'.repeat(16*1024*1024),w),false);
  db.prepare('UPDATE analytics_reports SET payload=? WHERE cache_key=?').run(Buffer.from('invalid'),key(39));assert.equal(cache.get(key(39)),undefined);
  assert.equal(db.prepare('SELECT count(*) n FROM analytics_report_people WHERE cache_key=?').get(key(39)).n,0);
  assert.equal(s.sessions().length,1);assert.deepEqual(db.pragma('foreign_key_check'),[]);
 }finally{w.dispose();s.close();}
});

test('failed publication rolls back the entire replacement and leaves the previous snapshot readable',()=>{
 const s=new StreamStore(':memory:'),db=(s as any).db,w=new AnalyticsWorkspace<{name:string}>(db),cache=new AnalyticsReportCache(db);
 try{
  w.people.set('person',{name:'Before'});cache.save(key(1),key(0),{version:1},w);
  const save=w.save.bind(w);w.save=key=>{save(key);throw Error('interrupted projection');};
  assert.throws(()=>cache.save(key(2),key(0),{version:2},w),/interrupted projection/);
  assert.deepEqual(cache.get(key(1)),{version:1});assert.equal(cache.get(key(2)),undefined);
  assert.equal(db.prepare('SELECT count(*) n FROM analytics_report_people').get().n,1);assert.deepEqual(db.pragma('foreign_key_check'),[]);
  w.save=()=>{throw Object.assign(Error('disk full'),{code:'SQLITE_FULL'});};assert.equal(cache.save(key(3),key(0),{version:3},w),false);assert.deepEqual(cache.get(key(1)),{version:1});
 }finally{w.dispose();s.close();}
});

test('entry limits apply even when snapshots are small enough for the byte budget',()=>{
 const s=new StreamStore(':memory:'),db=(s as any).db,w=new AnalyticsWorkspace(db),cache=new AnalyticsReportCache(db);
 try{assert.throws(()=>new AnalyticsWorkspace(db,'invalid'),/INVALID_ANALYTICS_CACHE_KEY/);for(let n=0;n<35;n++)cache.save(key(n),key(n),{n},w);assert.equal(db.prepare('SELECT count(*) n FROM analytics_reports').get().n,32);assert.equal(cache.get(key(0)),undefined);assert.deepEqual(cache.get(key(34)),{n:34});}
 finally{w.dispose();s.close();}
});

test('real analytical responses survive a full file close and restart without aggregation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'analytics-restart-')),path=join(dir,'data.sqlite');let s:StreamStore|undefined;
 try{
  s=new StreamStore(path,'ruslan');const at=Date.UTC(2026,9,1),id=s.startSession('owner','stream',at,'platform',at);s.streamSample(id,at,'game','Game','',10);s.endSession(id,at+180000);
  const opts={fromMs:0,toMs:at+86400000,ownerId:'owner',summaryOnly:true,includeInsights:true};
  let first:any;do{first=s.analytics(opts);}while(first.preparing);s.close();s=undefined;
  s=new StreamStore(path,'ruslan');const h=(s as any).history as AnalyticsHistory;(h as any).aggregate=()=>{throw Error('restart rebuilt history');};
  assert.deepEqual(s.analytics(opts),first);
 }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
