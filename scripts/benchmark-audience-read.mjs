import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(process.env.STREAM_PANEL_BENCHMARK_ROOT??'.');
const {StreamStore}=await import(pathToFileURL(join(root,'dist/packages/core/src/store.js')));
const streams=12,minutes=120,participants=80;
if(process.argv[2]==='seed'){
 const store=new StreamStore(process.argv[3]),base=Date.now()-14*86400000;
 const users=['jeetbot','streamelements','nightbot',...Array.from({length:participants-3},(_,i)=>'viewer'+i)];
 try{
  for(let n=0;n<streams;n++){
   const at=base+n*86400000,id=store.startSession('owner',String(n),at,'platform',at);
   for(let m=0;m<minutes;m++){
    store.streamSample(id,at+m*60000,'game','Game','',30);
    store.recordPoll(id,'owner',{startedAtMs:at+Math.max(0,m-1)*60000,completedAtMs:at+m*60000,status:'complete',userIds:users});
   }
   store.endSession(id,at+minutes*60000);
  }
 }finally{store.close();}
 process.exit(0);
}
// Keep bulk fixture ingestion in a separate process, as in benchmark-analytics-load.
// Its synchronous seed allocator high-water mark must not count as read-path memory.
const directory=mkdtempSync(join(tmpdir(),'sp-audience-read-')),path=join(directory,'fixture.sqlite');
let store;
try{
 const seed=performance.now();
 await new Promise((resolve,reject)=>{
  const child=fork(fileURLToPath(import.meta.url),['seed',path],{stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Fixture failed: ${code}`)));
 });
 const seedMs=performance.now()-seed;
 store=new StreamStore(path);
 const samples=[];let selected;
 for(let n=0;n<8;n++){const t=performance.now();const rows=store.sessions();samples.push(performance.now()-t);assert.equal(rows.length,streams);selected=rows[0].id;}
 const q={sessionId:selected,fromMs:0,toMs:Date.now(),rollingCore:true,coreWindowDays:90};
 const first=performance.now();let report;do{report=store.analytics(q);}while(report.preparing);
 const firstStreamMs=performance.now()-first,repeat=[];
 for(let n=0;n<8;n++){const t=performance.now();report=store.analytics(q);assert.ok(!report.preparing);repeat.push(performance.now()-t);}
 assert.equal(report.summary.attendees,participants-3);
 const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 console.log(JSON.stringify({fixture:{streams,minutes,participants,memberships:streams*minutes*participants},seedMs,streamListMedianMs:median(samples),firstStreamMs,repeatStreamMedianMs:median(repeat),online:report.timeline[0].viewers,rssMiB:process.memoryUsage().rss/1048576},null,2));
}finally{store?.close();rmSync(directory,{recursive:true,force:true});}
