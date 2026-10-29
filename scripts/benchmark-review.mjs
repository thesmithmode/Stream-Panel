import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.env.STREAM_PANEL_REVIEW_DIST??'dist');
const {StreamStore}=await import(pathToFileURL(root+'/packages/core/src/store.js'));
const {audienceAnalytics}=await import(pathToFileURL(root+'/packages/core/src/analytics.js'));
const s=new StreamStore(':memory:'),at=Date.UTC(2026,9,1),m=60000;
try{
 const id=s.startSession('owner','benchmark',at,'platform',at),users=Array.from({length:25},(_,i)=>'viewer'+i);
 for(let i=0;i<20;i++)s.recordPoll(id,'owner',{startedAtMs:at+i*m,completedAtMs:at+i*m+59999,status:'complete',userIds:users});
 s.endSession(id,at+30*m);
 if(process.env.STREAM_PANEL_REVIEW_TAGS==='1'){for(const p of s.persons())for(let i=0;i<20;i++)s.db.prepare('INSERT INTO person_tags(person_id,label) VALUES(?,?)').run(p.id,'tag-'+i);}
 const db=s.db,prepare=db.prepare.bind(db),q={fromMs:at,toMs:at+30*m,summaryOnly:true};let passes=0;
 db.prepare=sql=>{if(sql.startsWith('WITH raw AS'))passes++;return prepare(sql);};
 const cold=performance.now();let report;do{report=s.analytics(q);}while(report.preparing);const coldMs=performance.now()-cold,coldPasses=passes;
 passes=0;audienceAnalytics(db,q);const rawPasses=passes;
 const times=[];for(let i=0;i<20;i++){const start=performance.now();s.analytics(q);times.push(performance.now()-start);}
 times.sort((a,b)=>a-b);
 console.log(JSON.stringify({fixture:'25 people, 20 presence polls, one finished 30-minute stream'+(process.env.STREAM_PANEL_REVIEW_TAGS==='1'?', 500 tags':''),coldMs,coldGroupingPasses:coldPasses,rawGroupingPasses:rawPasses,hotP50Ms:times[9],hotP95Ms:times[18],responseBytes:Buffer.byteLength(JSON.stringify(report)),rssMiB:process.memoryUsage().rss/1048576},null,2));
}finally{s.close();}
