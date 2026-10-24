import {api,getDataRevision} from './api';
import {clearSubscriberCache,preloadSubscriberPeriods} from './subscriber-cache';
import {loadAnalyticsView} from './analytics-view';
// Shared across mounts. A profile is always part of the key and the request header.
let generation=0;
const reports=new Map<string,{value?:any;until:number;pending:boolean;task:Promise<any>}>();
export interface OverviewTotals {streams:number;durationMinutes:number;attendees:number;messages:number;donations:number;totals:Record<string,string>}
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
export function clearAnalyticsCache(){generation++;reports.clear();overviews.clear();clearSubscriberCache();}
export function loadAnalytics(profile:string,q:URLSearchParams,force=false){
 const id=key(profile,q),prior=reports.get(id);
 if(prior&&(prior.pending||(!force&&prior.until>Date.now())))return prior.task;
 const entry={value:prior?.value,until:0,pending:true,task:undefined as unknown as Promise<any>};
 entry.task=(async()=>{
  let result=await api(`analytics?${q}`,undefined,undefined,profile);
  while(result.preparing)result=await api(`analytics?${q}`,undefined,undefined,profile);
  if(result.filters&&['category','source','timezone'].some(field=>result.filters[field]!==q.get(field)))throw new Error('Сервер вернул данные для других фильтров. Повторите обновление.');
  entry.pending=false;entry.value=result;entry.until=Date.now()+60000;return result;
 })().catch(error=>{if(reports.get(id)===entry)reports.delete(id);throw error;});
 reports.delete(id);reports.set(id,entry);
 while(reports.size>8)reports.delete(reports.keys().next().value!);
 return entry.task;
}
export function summaryQuery(from:number,to:number,source:string,category:string,timezone:string,resolution:number,sort:string){
 return new URLSearchParams({from:String(from),to:String(to),source,category,timezone,mode:'summary',insights:'1',clockCompact:'1',clockDay:'all',clockResolution:String(resolution),audienceOffset:'0',audienceSearch:'',audienceSort:sort,audienceCoreOnly:'0'});
}
export async function preloadAnalytics(profiles:readonly string[]){
 const current=generation;
 // Start authorized profiles together; one long report must not delay its peer.
 await Promise.allSettled(profiles.map(async profile=>{try{
  if(current!==generation)return;
  const settings=await api('settings',undefined,undefined,profile),view=loadAnalyticsView(()=>localStorage,profile);
  if(current!==generation)return;
  let timezone=settings.timezone;
  try{timezone=JSON.parse(localStorage.getItem(`sp-analytics-${profile}`)??'null')?.timezone??timezone;}catch{/* optional preferences */}
  void preloadSubscriberPeriods(profile,timezone);
  await loadAnalytics(profile,summaryQuery(0,Math.floor(Date.now()/60000)*60000,'all','',timezone,view.resolution,view.sort));
 }catch{/* Opening analytics retains its normal retry/error flow. */}}));
}
