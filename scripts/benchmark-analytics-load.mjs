import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StreamStore} from '../dist/packages/core/src/store.js';
import {StoreClient} from '../dist/apps/daemon/src/db.js';
const profiles=['ruslan','gulnaz'];
const count=Number(process.env.STREAM_PANEL_BENCHMARK_STREAMS??10000);
assert.ok(Number.isSafeInteger(count)&&count>=2&&count%2===0);
if(process.argv[2]==='seed'){
 for(const profile of profiles){const s=new StreamStore(process.argv[3],profile),db=s.db;
  try{const insert=db.prepare("INSERT INTO sessions(id,account_id,stream_id,kind,started_at_ms,recording_started_at_ms,ended_at_ms,end_quality) VALUES(?,'owner',?,'platform',?,?,?,'confirmed')"),sample=db.prepare("INSERT INTO stream_samples VALUES(?,?,'game','Game','',?,NULL)");
   db.transaction(()=>{for(let i=0;i<count/2;i++){const at=Date.now()-(count/2-i)*86400000,id=String(i);insert.run(id,id,at,at,at+60000);sample.run(id,at,i%7);}})();
  }finally{s.close();}
 }
 process.exit(0);
}
const dir=await mkdtemp(join(tmpdir(),'sp-analytics-load-')),path=join(dir,'facts.sqlite');
const clients=[];
try{
 await new Promise((resolve,reject)=>{const child=fork(fileURLToPath(import.meta.url),['seed',path],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Fixture failed: ${code}`)));});
 clients.push(...profiles.map(p=>new StoreClient(path,p)));
 await Promise.all(clients.map(c=>c.ready));
 const q={fromMs:0,toMs:Date.now(),ownerId:'owner',summaryOnly:true,includeInsights:true,clockCompact:true,panel:'dynamics'};
 let peak=process.memoryUsage().rss;const observe=()=>{peak=Math.max(peak,process.memoryUsage().rss,process.resourceUsage().maxRSS*1024);};
 const backfill=performance.now(),collector=[];let jobs=0;
 for(const client of clients){let result;do{
  const work=client.call('advanceAnalytics',q),t=performance.now();
  await clients[0].call('changes');collector.push(performance.now()-t);
  result=await work;observe();jobs++;
 }while(result.pending);}
 for(const client of clients){let report;do{report=await client.call('analytics',q);observe();}while(report.preparing);assert.equal(report.summary.streams,count/2);assert.ok(report.streamComparison.length<=32);}
 const backfillMs=performance.now()-backfill,times=[];
 let responseBytes=0;
 for(let i=0;i<40;i++){const client=clients[i%clients.length],t=performance.now(),report=await client.call('analytics',q);times.push(performance.now()-t);responseBytes=Math.max(responseBytes,Buffer.byteLength(JSON.stringify(report)));observe();}
 const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
 const result={streams:count,profiles:profiles.length,fixture:'one recorded minute and one viewer sample per finished stream; no chat/presence',backfillMs:Math.round(backfillMs),batches:jobs,p95Ms:percentile(times,.95),collectorP95Ms:percentile(collector,.95),responseBytes,peakRssMiB:peak/1048576};
 console.log(JSON.stringify(result,null,2));
 assert.ok(result.p95Ms<=300,`Cached API p95 ${result.p95Ms} exceeds 300ms`);
 assert.ok(result.peakRssMiB<512,`Whole-process RSS ${result.peakRssMiB} exceeds service memory limit`);
}finally{await Promise.all(clients.map(c=>c.stop()));await rm(dir,{recursive:true,force:true});}
