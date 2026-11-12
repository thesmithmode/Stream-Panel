// Isolated real HTTP-handler benchmark; no provider/server access. Node 24, pnpm build first.
import {mkdtemp,rm,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {createApplication}=await import(pathToFileURL(resolve(process.env.STREAM_PANEL_BENCHMARK_ROOT??'.','dist/apps/daemon/src/server.js')));
import {gunzipSync} from 'node:zlib';
const root=await mkdtemp(join(tmpdir(),'sp-screen-budget-'));
let app;
try{
 const fixture=join(root,'fixture');app=await createApplication(fixture,0,false,{});
 const now=Math.floor(Date.now()/60000)*60000,users=Array.from({length:20},(_,i)=>'viewer'+i);let session;
 for(let n=0;n<12;n++){
  const at=now-(n+1)*3*86400000;session=await app.db.call('startSession','owner',String(n),at,'platform',at);
  for(let m=0;m<30;m++){
   await app.db.call('streamSample',session,at+m*60000,'game','Game','',20);
   await app.db.call('recordPoll',session,'owner',{startedAtMs:at+m*60000,completedAtMs:at+m*60000,status:'complete',userIds:users});
  }
  await app.db.call('endSession',session,at+30*60000);
 }
 await app.app.close();app=undefined;
 const rows=[];
 for(const period of [7,30,'all','stream'])for(const panel of period==='stream'?['stream']:['dynamics','time','audience']){
  const dir=join(root,String(period)+'-'+panel);await cp(fixture,dir,{recursive:true});
  app=await createApplication(dir,0,false,{});
  const host='127.0.0.1:0',origin='http://127.0.0.1:0';
  const auth=await app.app.inject({method:'POST',url:'/api/v1/bootstrap',headers:{host,origin},payload:{key:app.bootstrap().split('#key=')[1]}});
  const headers={host,cookie:auth.cookies.map(c=>`${c.name}=${c.value}`).join('; '),'accept-encoding':'gzip'};
  const q=new URLSearchParams({from:String(period==='all'||period==='stream'?0:now-period*86400000),to:String(now),source:'all',category:'',timezone:'Europe/Moscow',mode:'summary',insights:'1',clockCompact:'1',clockDay:'all',clockResolution:'15',attendanceOnly:'1'});
  if(process.env.STREAM_PANEL_BENCHMARK_ROOT===undefined&&panel==='time')q.set('clockActivityCompact','1');
  if(period==='stream'){q.set('session',session);if(process.env.STREAM_PANEL_BENCHMARK_ROOT===undefined)q.set('view','stream');}else q.set('panel',panel);
  const url='/api/v1/analytics?'+q;
  const measure=async validators=>{
   const start=performance.now();let count=0,response,value;
   do{response=await app.app.inject({url,headers:{...headers,...validators}});count++;
    if(response.statusCode===304)break;
    if(response.statusCode!==200)throw Error(response.body);
    value=JSON.parse(response.headers['content-encoding']==='gzip'?gunzipSync(response.rawPayload).toString():response.body);
   }while(value.preparing&&count<100);
   if(value?.preparing)throw Error('Report unfinished');
   return {ms:+(performance.now()-start).toFixed(2),requests:count,bytes:response.rawPayload.length,jsonBytes:value?Buffer.byteLength(JSON.stringify(value)):0,status:response.statusCode,etag:response.headers.etag};
  };
  const cold=await measure(),warm=await measure(),validated=await measure({'if-none-match':warm.etag});
  const row={period,panel,cold,warm,validated};rows.push(row);console.log(JSON.stringify(row));
  if(process.env.STREAM_PANEL_PERF_GATE==='1'){
   if(cold.ms>3000||warm.ms>300||warm.jsonBytes>(period==='stream'?2*1024*1024:300*1024)||validated.status!==304)throw Error('Screen API budget exceeded: '+JSON.stringify(row));
  }
  await app.app.close();app=undefined;
 }
 console.log(JSON.stringify({fixture:{streams:12,minutes:30,participants:20},scope:'HTTP handlers + worker RPC; process-cold, no persisted projections; excludes browser and network',rows},null,2));
}finally{await app?.app.close();await rm(root,{recursive:true,force:true});}
