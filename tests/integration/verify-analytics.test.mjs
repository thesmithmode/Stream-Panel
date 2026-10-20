import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import Database from 'better-sqlite3';import {StreamStore} from '../../dist/packages/core/src/store.js';
test('deployed analytics probe uses a private copy, emits timing counts only and leaves live source facts and caches untouched',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sp-analytics-probe-')),path=join(dir,'data.sqlite');
 try{
  for(const profile of ['ruslan','gulnaz']){
   const s=new StreamStore(path,profile),at=Date.now()-86400000;try{const id=s.startSession('private-owner','private-stream',at,'platform',at);s.streamSample(id,at,'game','Private title','',4);s.endSession(id,at+60000);}finally{s.close();}
   await mkdir(join(dir,'profiles',profile),{recursive:true});await writeFile(join(dir,'profiles',profile,'secrets.json'),JSON.stringify({youtubeClientSecret:'must-never-print',excludedBotLogins:[]}));
  }
  const db=new Database(path,{readonly:true});const before=db.prepare('SELECT * FROM p_ruslan_analytics_reports').all();
  try{
   const {stdout}=await promisify(execFile)(process.execPath,[resolve('scripts/verify-analytics.mjs')],{env:{...process.env,STREAM_PANEL_DATA_DIR:dir}});
   const rows=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows.length,2);for(const row of rows){assert.equal(row.analyticsProbe,true);assert.equal(row.streams,1);assert.equal(row.hotRequests,1);assert.ok(row.responseBytes>0);}
   assert.doesNotMatch(stdout,/must-never-print|private-owner|Private title|private-stream/);assert.deepEqual(db.prepare('SELECT * FROM p_ruslan_analytics_reports').all(),before);assert.equal(db.prepare('SELECT count(*) n FROM p_ruslan_sessions').get().n,1);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  }finally{db.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
