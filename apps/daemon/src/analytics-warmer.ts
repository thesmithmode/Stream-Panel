import {analyticsSettings} from './analytics-settings.js';
import type {ConfigurationPort} from './config.js';
import type {StorePort} from './store-contract.js';
type Runtime={configuration:ConfigurationPort;db:StorePort<'warmAnalytics'|'changes'|'advanceAnalytics'>&{queueStatus?:()=>{pending:number}}};
/** Serial background catch-up: bounded SQLite chunks, then idle checks once a minute. */
export function startAnalyticsWarmer(runtimes:()=>Iterable<Runtime>,enabled:()=>boolean,onError:()=>void){
 const versions=new WeakMap<object,string>();
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const run=async()=>{
  let preparing=false;
  if(enabled())for(const runtime of runtimes()){
   if(stopped)break;

   if((runtime.db.queueStatus?.().pending??0)>0){preparing=true;continue;}
   try{
    const cfg=runtime.configuration.value;
    const change=await runtime.db.call('changes');
    const signature=JSON.stringify([change.versions.activity,change.versions.people,change.versions.donations,change.versions.follows,cfg.analyticsSettings,cfg.excludedBotLogins,cfg.twitch?.userId,cfg.youtube?.userId]);
    if(versions.get(runtime.db)===signature)continue;
    const options={...analyticsSettings(cfg.analyticsSettings),fromMs:0,toMs:Date.now(),excludedLogins:cfg.excludedBotLogins,ownerId:cfg.twitch?.userId??'',youtubeAccount:cfg.youtube?.userId??cfg.youtubeAccountId??''};
    const queued=await runtime.db.call('advanceAnalytics',options);
    if(queued.pending){preparing=true;continue;}
    const result=await runtime.db.call('warmAnalytics',options,false);
    preparing ||= result.preparing;
    if(!result.preparing)versions.set(runtime.db,signature);
   }catch{onError();}
  }
  if(!stopped)timer=setTimeout(()=>void run(),preparing?250:60000);
 };
 void run();
 return ()=>{stopped=true;clearTimeout(timer);};
}
