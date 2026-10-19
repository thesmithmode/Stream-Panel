import type {StorePort} from './store-contract.js';
type Runtime={db:StorePort<'purgeRecentEvents'>&{queueStatus?:()=>{pending:number}}};
/** One bounded batch per profile per minute; no overlap or busy catch-up loops. */
export function startEventRetention(runtimes:()=>Iterable<Runtime>,enabled:()=>boolean,onError:()=>void){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const run=async()=>{
  if(enabled())for(const runtime of runtimes()){
   if(stopped)break;
   if((runtime.db.queueStatus?.().pending??0)>0)continue;
   try{await runtime.db.call('purgeRecentEvents');}catch{onError();}
  }
  if(!stopped)timer=setTimeout(()=>void run(),60000);
 };
 void run();
 return ()=>{stopped=true;clearTimeout(timer);};
}
