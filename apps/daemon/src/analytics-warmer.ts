import {analyticsSettings,analyticsCalculationSettings} from './analytics-settings.js';
import type {ConfigurationPort} from './config.js';
import type {StorePort} from './store-contract.js';
type Runtime={configuration:ConfigurationPort;db:StorePort<'warmAnalytics'|'changes'|'advanceAnalytics'|'analytics'|'followerChanges'>&{queueStatus?:()=>{pending:number};onChange?:(listener:()=>void)=>()=>void}};
/** Serial background catch-up: bounded SQLite chunks, then idle checks once a minute. */
export function startAnalyticsWarmer(runtimes:()=>Iterable<Runtime>,enabled:()=>boolean,onError:()=>void){
 const versions=new WeakMap<object,string>();
 const followingVersions=new WeakMap<object,string>();
 const windows=new WeakMap<object,{signature:string;toMs:number;index:number}>();
 let stopped=false,running=false,dirty=false,timer:ReturnType<typeof setTimeout>|undefined;
 const subscriptions=new Map<Runtime,()=>void>();
 const schedule=(delay:number)=>{clearTimeout(timer);if(!stopped)timer=setTimeout(()=>void run(),delay);};
 const wake=()=>{if(stopped||dirty)return;dirty=true;if(!running)schedule(250);};
 const run=async()=>{
  if(stopped||running)return;
  running=true;dirty=false;
  let preparing=false;
  const active=new Set(runtimes());
  for(const [runtime,unsubscribe] of subscriptions)if(!active.has(runtime)){unsubscribe();subscriptions.delete(runtime);}
  for(const runtime of active)if(!subscriptions.has(runtime)&&runtime.db.onChange)subscriptions.set(runtime,runtime.db.onChange(wake));
  if(enabled())for(const runtime of active){
   if(stopped)break;

   if((runtime.db.queueStatus?.().pending??0)>0){preparing=true;continue;}
   try{
    const cfg=runtime.configuration.value;
    const change=await runtime.db.call('changes');
    if(stopped)break;
    const rules=analyticsCalculationSettings(cfg.analyticsSettings),includeBots=analyticsSettings(cfg.analyticsSettings).includeBots;
    const signature=JSON.stringify([change.versions.activity,change.versions.people,change.versions.donations,change.versions.follows,rules,includeBots,cfg.excludedBotLogins,cfg.twitch?.userId,cfg.youtube?.userId]);
    // Following is independent of the expensive audience catch-up. Prepare it
    // first, once per data version and minute, with the exact UI period bounds.
    const followEnd=Math.floor(Date.now()/60000)*60000;
    const followSignature=JSON.stringify([signature,followEnd]);
    if(followingVersions.get(runtime.db)!==followSignature){
     for(const days of [0,7,30]){
      if(stopped)break;
      if((runtime.db.queueStatus?.().pending??0)>0){preparing=true;break;}
      await runtime.db.call('followerChanges',days?followEnd-days*86400000:0,followEnd,includeBots?false:cfg.excludedBotLogins);
      if(days===30)followingVersions.set(runtime.db,followSignature);
     }
     if(stopped)break;
    }
    if(versions.get(runtime.db)===signature)continue;
    const options={...rules,rollingCore:true,fromMs:0,toMs:Date.now(),excludedLogins:includeBots?false as const:cfg.excludedBotLogins,ownerId:cfg.twitch?.userId??'',youtubeAccount:cfg.youtube?.userId??cfg.youtubeAccountId??''};
    const queued=await runtime.db.call('advanceAnalytics',options);
    if(stopped)break;
    if(queued.pending){preparing=true;continue;}
    const result=windows.get(runtime.db)?.signature===signature?{preparing:false}:await runtime.db.call('warmAnalytics',options,false);
    if(stopped)break;
    preparing ||= result.preparing;
    if(!result.preparing){
     // Keep a fixed end while a multi-slice report is being prepared. Moving
     // bounds would create a fresh job on every tick and never finish it.
     let job=windows.get(runtime.db);
     if(!job||job.signature!==signature){job={signature,toMs:Math.floor(Date.now()/60000)*60000,index:0};windows.set(runtime.db,job);}
     if(job.index<2){
      if((runtime.db.queueStatus?.().pending??0)>0){preparing=true;continue;}
      const days=[7,30][job.index]!;
      const report=await runtime.db.call('analytics',{...options,fromMs:job.toMs-days*86400000,toMs:job.toMs,source:'all',category:'',summaryOnly:true,includeInsights:true});
      if(stopped)break;
      if(!report.preparing)job.index++;
     }
     if(job.index===2){versions.set(runtime.db,signature);windows.delete(runtime.db);}
     else preparing=true;
    }
   }catch{if(!stopped)onError();}
  }
  running=false;
  schedule(preparing||dirty?250:60000);
 };
 void run();
 return ()=>{stopped=true;clearTimeout(timer);for(const unsubscribe of subscriptions.values())unsubscribe();subscriptions.clear();};
}
