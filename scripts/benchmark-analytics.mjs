import {StreamStore} from '../dist/packages/core/src/store.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Reproducible manual benchmark: pnpm build:core && node scripts/benchmark-analytics.mjs 1200
const count=Number(process.argv[2]??1200);
if(!Number.isInteger(count)||count<1||count>5000)throw Error('Expected 1–5000 streams');
const directory=await mkdtemp(join(tmpdir(),'stream-panel-analytics-bench-')),store=new StreamStore(join(directory,'facts.sqlite'));
const db=store.db,minute=60000,base=Date.UTC(2022,0,1);
try{
 db.transaction(()=>{for(let i=0;i<count;i++){
  const at=base+i*86400000,id=store.startSession('owner',String(i),at,'platform',at);
  store.streamSample(id,at,'dota','Dota 2','',10+i%10);store.streamSample(id,at+30*minute,'irl','IRL','',20+i%10);
  store.recordPoll(id,'owner',{startedAtMs:at,completedAtMs:at+29*minute,status:'complete',userIds:['a','b','c','d']});
  for(let j=0;j<20;j++)store.ingest({source:'twitch',accountId:'owner',externalId:`${i}-${j}`,type:'chat.message',actor:{externalId:['a','b','c','d'][j%4],displayName:`Viewer ${j%4}`},occurredAtMs:at+j*3*minute,receivedAtMs:at+j*3*minute,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{count:1}});
  store.endSession(id,at+60*minute);
 }})();
 const query={fromMs:0,toMs:base+(count+1)*86400000,timezone:'Europe/Moscow',ownerId:'owner',summaryOnly:true};
 for(const category of ['','dota','irl','','dota','irl']){
  const started=performance.now();let report,requests=0;
  do{report=store.analytics({...query,category});requests++;}while(report.preparing);
  console.log(JSON.stringify({category:category||'all',ms:Math.round((performance.now()-started)*10)/10,requests,streams:report.summary.streams,messages:report.summary.messages,derived:db.prepare('SELECT count(*) rows,coalesce(sum(length(payload)),0) bytes FROM analytics_stream_cache').get()}));
 }
}finally{store.close();await rm(directory,{recursive:true,force:true});}
