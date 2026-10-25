// Measure the deployed calculations on a consistent private copy. Never migrate,
// bake or benchmark in the collectors' live database connection.
import Database from 'better-sqlite3';
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../dist/packages/core/src/store.js';
import {analyticsSettings} from '../dist/apps/daemon/src/analytics-settings.js';
import {localDateWindow} from '../dist/packages/core/src/time-audience.js';
import {gzipSync} from 'node:zlib';
const dir=process.env.STREAM_PANEL_DATA_DIR;
if(!dir)throw Error('DATA_DIRECTORY_REQUIRED');
const staging=await mkdtemp(join(tmpdir(),'sp-analytics-check-'));
await chmod(staging,0o700);
const source=new Database(join(dir,'data.sqlite'),{readonly:true,fileMustExist:true});
try{
 await source.backup(join(staging,'data.sqlite'));
 for(const profile of ['ruslan','gulnaz']){
  const cfg=JSON.parse(await readFile(join(dir,'profiles',profile,'secrets.json'),'utf8'));
  const store=new StreamStore(join(staging,'data.sqlite'),profile);
  try{
   // Check the actual graph reports on the private copy; log counts, never credentials.
   const to=Date.now(),timezone=analyticsSettings(cfg.analyticsSettings).timezone;
   const day=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(to);
   for(const source of ['twitch','youtube'])for(const days of [1,7,30]){
    const account=source==='twitch'?cfg.twitch?.userId??'':cfg.youtube?.userId??cfg.youtubeAccountId??'';
    const from=localDateWindow(new Date(Date.parse(day)-(days-1)*86400000).toISOString().slice(0,10),timezone).from;
    const report=store.subscriberHistory({source,account,from,to});
    console.log(JSON.stringify({subscriberProbe:true,profile,source,days,points:report.counts.length,total:report.total,firstAt:report.firstAt,lastAt:report.lastAt}));
   }
   const options={...analyticsSettings(cfg.analyticsSettings),fromMs:0,toMs:Math.floor(Date.now()/60000)*60000,source:'all',category:'',summaryOnly:true,includeInsights:true,excludedLogins:cfg.excludedBotLogins??[],ownerId:cfg.twitch?.userId??'',youtubeAccount:cfg.youtube?.userId??cfg.youtubeAccountId??''};
   const read=(query=options)=>{let report,requests=0;const start=performance.now();do{report=store.analytics(query);if(++requests>10000)throw Error('ANALYTICS_DID_NOT_FINISH');}while(report.preparing);return {report,requests,ms:Math.round(performance.now()-start)};};
   const first=read(),active=store.sessions().some(s=>s.ended_at_ms===null),start=performance.now();
   if(!active){let rounds=0;while(store.warmAnalytics(options,true).preparing)if(++rounds>10000)throw Error('WARM_DID_NOT_FINISH');}
   const warmMs=Math.round(performance.now()-start),repeat=read();
   if(JSON.stringify(first.report.summary)!==JSON.stringify(repeat.report.summary))throw Error('WARM_CHANGED_SUMMARY');
   const compact=read({...options,clockCompact:true,clockDay:'all',clockResolution:15});
   if(JSON.stringify(compact.report.summary)!==JSON.stringify(repeat.report.summary))throw Error('COMPACT_CHANGED_SUMMARY');
   const audience=read({...options,panel:'audience',attendanceOnly:true}),dynamics=read({...options,panel:'dynamics',attendanceOnly:true});
   const attendeeCount=audience.report.audiencePage?.total??audience.report.audience.length;
   if(attendeeCount!==audience.report.summary.attendees)throw Error('ATTENDANCE_COUNT_MISMATCH');
   if(JSON.stringify(audience.report.summary)!==JSON.stringify(repeat.report.summary)||JSON.stringify(dynamics.report.summary)!==JSON.stringify(repeat.report.summary))throw Error('PROJECTION_CHANGED_SUMMARY');
   console.log(JSON.stringify({screenProbe:true,profile,attendees:attendeeCount,fullBytes:Buffer.byteLength(JSON.stringify(repeat.report)),dynamicsBytes:Buffer.byteLength(JSON.stringify(dynamics.report)),audienceBytes:Buffer.byteLength(JSON.stringify(audience.report)),metadataBytes:Buffer.byteLength(JSON.stringify(store.changes()))}));
   const periods=[];
   for(const days of [7,30]){
    const query={...options,clockCompact:true,clockDay:'all',clockResolution:15,fromMs:options.toMs-days*86400000},cold=read(query),hot=read(query),shifted=read({...query,fromMs:query.fromMs+60000,toMs:query.toMs+60000});
    if(JSON.stringify(cold.report.summary)!==JSON.stringify(hot.report.summary))throw Error('REPEAT_CHANGED_SUMMARY');
    periods.push({days,firstReadyMs:cold.ms,firstRequests:cold.requests,hotReadyMs:hot.ms,shiftedReadyMs:shifted.ms,shiftedRequests:shifted.requests});
   }
   console.log(JSON.stringify({analyticsProbe:true,profile,active,firstReadyMs:first.ms,firstRequests:first.requests,warmMs,hotReadyMs:repeat.ms,hotRequests:repeat.requests,streams:repeat.report.summary.streams,responseBytes:Buffer.byteLength(JSON.stringify(repeat.report)),compactResponseBytes:Buffer.byteLength(JSON.stringify(compact.report)),compactHotReadyMs:compact.ms,gzipBytes:gzipSync(JSON.stringify(repeat.report),{level:1}).length,periods}));
  }finally{store.close();}
 }
}finally{source.close();await rm(staging,{recursive:true,force:true});}
