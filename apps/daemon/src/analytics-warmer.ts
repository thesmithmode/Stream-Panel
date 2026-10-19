import {analyticsSettings} from './analytics-settings.js';
import type {ConfigurationPort} from './config.js';
import type {StorePort} from './store-contract.js';
type Runtime={configuration:ConfigurationPort;db:StorePort<'warmAnalytics'>};
/** Serial background catch-up: bounded SQLite chunks, then idle checks once a minute. */
export function startAnalyticsWarmer(runtimes:()=>Iterable<Runtime>,enabled:()=>boolean,onError:()=>void){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const run=async()=>{
  let preparing=false;
  if(enabled())for(const runtime of runtimes()){
   if(stopped)break;
   try{
    const cfg=runtime.configuration.value;
    const result=await runtime.db.call('warmAnalytics',{...analyticsSettings(cfg.analyticsSettings),fromMs:0,toMs:Date.now(),excludedLogins:cfg.excludedBotLogins,ownerId:cfg.twitch?.userId??'',youtubeAccount:cfg.youtube?.userId??cfg.youtubeAccountId??''});
    preparing ||= result.preparing;
   }catch{onError();}
  }
  if(!stopped)timer=setTimeout(()=>void run(),preparing?50:60000);
 };
 void run();
 return ()=>{stopped=true;clearTimeout(timer);};
}
