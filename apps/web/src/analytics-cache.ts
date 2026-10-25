import {api,getDataRevision} from './api';
import {analyticsReport,useReport,type SharedReport} from './analytics-load';
import {clearSubscriberCache,preloadSubscriberPeriods} from './subscriber-cache';
import {loadAnalyticsView} from './analytics-view';
// Shared across mounts. A profile is always part of the key and the request header.
let generation=0;
const reports=new Map<string,{value?:any;until:number;pending:boolean;task:Promise<any>;controller:AbortController;users:number}>();
export interface OverviewTotals {records?:{online:{value:number;at:number}|null;messages:{value:number;at:number}|null};streams:number;durationMinutes:number;attendees:number;messages:number;donations:number;totals:Record<string,string>}
// Returning to Overview reuses its compact snapshot. Explicit/timed refresh still reads fresh data.
const overviews=new Map<string,{until:number;pending:boolean;task:Promise<OverviewTotals>}>();
export function loadOverview(profile:string,force=false){
 const id=JSON.stringify([profile,getDataRevision(profile)]),prior=overviews.get(id);
 if(prior&&(prior.pending||(!force&&prior.until>Date.now())))return prior.task;
 const entry={until:0,pending:true,task:undefined as unknown as Promise<OverviewTotals>};
 entry.task=api<OverviewTotals>('overview',undefined,undefined,profile).then(value=>{entry.pending=false;entry.until=Date.now()+60000;return value;}).catch(error=>{if(overviews.get(id)===entry)overviews.delete(id);throw error;});
 overviews.delete(id);overviews.set(id,entry);
 while(overviews.size>8)overviews.delete(overviews.keys().next().value!);
 return entry.task;
}
function key(profile:string,q:URLSearchParams){
 const params=new URLSearchParams(q);
 // The landing report moves with the clock, while its historical facts stay the same.
 if(params.get('from')==='0'&&Math.abs(Number(params.get('to'))-Date.now())<120000)params.delete('to');
 params.sort();return JSON.stringify([profile,getDataRevision(profile),params.toString()]);
}
export function cachedAnalytics(profile:string,q:URLSearchParams){return reports.get(key(profile,q))?.value;}
const preloads=new Map<string,{until:number;task:Promise<void>}>();
let preloadController=new AbortController();
export function clearAnalyticsCache(){generation++;preloadController.abort();preloadController=new AbortController();preloads.clear();for(const entry of reports.values())entry.controller.abort();reports.clear();overviews.clear();clearSubscriberCache();}
export function loadAnalytics(profile:string,q:URLSearchParams,force=false,signal?:AbortSignal){
 if(signal?.aborted)return Promise.reject(signal.reason);
 const id=key(profile,q),prior=reports.get(id);
 if(prior&&!prior.controller.signal.aborted&&(prior.pending||(!force&&prior.until>Date.now())))return useReport(prior,signal);
 const entry:SharedReport<any>&{value?:any;until:number}={value:prior?.value,until:0,pending:true,users:0,controller:new AbortController(),task:undefined as unknown as Promise<any>};
 entry.task=(async()=>{
  const result=await analyticsReport(signal=>api(`analytics?${q}`,undefined,signal,profile),entry.controller.signal);
  if(result.filters&&['category','source','timezone'].some(field=>result.filters[field]!==q.get(field)))throw new Error('Сервер вернул данные для других фильтров. Повторите обновление.');
  entry.pending=false;entry.value=result;entry.until=Date.now()+60000;return result;
 })().catch(error=>{if(reports.get(id)===entry)reports.delete(id);throw error;});
 reports.delete(id);reports.set(id,entry);
 while(reports.size>8){const oldest=reports.keys().next().value!;reports.get(oldest)!.controller.abort();reports.delete(oldest);}
 return useReport(entry,signal);
}
export function summaryQuery(from:number,to:number,source:string,category:string,timezone:string,resolution:number,sort:string){
 return new URLSearchParams({from:String(from),to:String(to),source,category,timezone,mode:'summary',insights:'1',clockCompact:'1',clockDay:'all',clockResolution:String(resolution),audienceOffset:'0',audienceSearch:'',audienceSort:sort,audienceCoreOnly:'0'});
}
export async function preloadAnalytics(profiles:readonly string[]){
 const current=generation,signal=preloadController.signal;
 await Promise.allSettled(profiles.map(profile=>{
  const id=JSON.stringify([profile,getDataRevision(profile)]),prior=preloads.get(id);
  if(prior&&prior.until>Date.now())return prior.task;
  const entry={until:Infinity,task:undefined as unknown as Promise<void>};
  entry.task=(async()=>{try{
   if(current!==generation)return;
   const settings=await api('settings',undefined,signal,profile),view=loadAnalyticsView(()=>localStorage,profile);
   if(current!==generation)return;
   let timezone=settings.timezone;
   try{timezone=JSON.parse(localStorage.getItem(`sp-analytics-${profile}`)??'null')?.timezone??timezone;}catch{/* optional preferences */}
   void preloadSubscriberPeriods(profile,timezone);
   await loadAnalytics(profile,summaryQuery(0,Math.floor(Date.now()/60000)*60000,'all','',timezone,view.resolution,view.sort),false,signal);
   entry.until=Date.now()+60000;
  }catch{if(preloads.get(id)===entry)preloads.delete(id);}})();
  preloads.set(id,entry);
  while(preloads.size>8)preloads.delete(preloads.keys().next().value!);
  return entry.task;
 }));
}
