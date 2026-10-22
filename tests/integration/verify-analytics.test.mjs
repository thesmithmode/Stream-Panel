import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import Database from 'better-sqlite3';import {StreamStore} from '../../dist/packages/core/src/store.js';
test('deployed analytics probe uses a private copy, emits timing counts only and leaves live source facts and caches untouched',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-analytics-probe-')),path=join(dir,'data.sqlite');
 try{
  for(const profile of ['ruslan','gulnaz']){
   const s=new StreamStore(path,profile),at=Date.now()-86400000;try{const id=s.startSession('private-owner','private-stream',at,'platform',at);s.streamSample(id,at,'game','Private title','',4);s.endSession(id,at+60000);s.followingSnapshot('twitch','private-owner',[],true,at,profile==='ruslan'?144:145);s.youtubeSnapshot('private-youtube','channel',{statistics:{subscriberCount:profile==='ruslan'?'29':'73'}},at);}finally{s.close();}
   await mkdir(join(dir,'profiles',profile),{recursive:true});await writeFile(join(dir,'profiles',profile,'secrets.json'),JSON.stringify({twitch:{userId:'private-owner'},youtubeAccountId:'private-youtube',youtubeClientSecret:'must-never-print',excludedBotLogins:[]}));
  }
  const db=new Database(path,{readonly:true});const before=db.prepare('SELECT * FROM p_ruslan_analytics_reports').all(),beforeCounts=db.prepare('SELECT * FROM p_ruslan_subscriber_counts').all();
  try{
   const {stdout}=await promisify(execFile)(process.execPath,[resolve('scripts/verify-analytics.mjs')],{env:{...process.env,STREAM_PANEL_DATA_DIR:dir}});
   const rows=stdout.trim().split('\n').map(line=>JSON.parse(line)),analytics=rows.filter(row=>row.analyticsProbe),subscribers=rows.filter(row=>row.subscriberProbe);assert.equal(rows.length,14);assert.equal(analytics.length,2);for(const row of analytics){assert.equal(row.streams,1);assert.equal(row.hotRequests,1);assert.ok(row.responseBytes>0);}
   assert.equal(subscribers.length,12);for(const profile of ['ruslan','gulnaz'])for(const source of ['twitch','youtube']){
    const reports=subscribers.filter(row=>row.profile===profile&&row.source===source);assert.deepEqual(reports.map(row=>row.days),[1,7,30]);for(const row of reports){assert.equal(row.points,1);assert.equal(row.total,source==='twitch'?(profile==='ruslan'?144:145):(profile==='ruslan'?29:73));assert.ok(row.lastAt>0);}
   }
   assert.doesNotMatch(stdout,/must-never-print|private-owner|private-youtube|Private title|private-stream/);assert.deepEqual(db.prepare('SELECT * FROM p_ruslan_analytics_reports').all(),before);assert.deepEqual(db.prepare('SELECT * FROM p_ruslan_subscriber_counts').all(),beforeCounts);assert.equal(db.prepare('SELECT count(*) n FROM p_ruslan_sessions').get().n,1);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  }finally{db.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
