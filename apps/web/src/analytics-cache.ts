import {clearScreenData} from './screen-data';
import {api,getDataRevision,getServerRevision} from './api';
import {analyticsReport,useReport,type SharedReport} from './analytics-load';
import {clearSubscriberCache} from './subscriber-cache';
// Shared across mounts. A profile is always part of the key and the request header.
const snapshots=new Map<string,any>();
const reports=new Map<string,{value?:any;until:number;pending:boolean;task:Promise<any>;controller:AbortController;users:number}>();
export interface OverviewTotals {records?:{online:{value:number;at:number}|null;messages:{value:number;at:number}|null;peakOnline?:{value:number;at:number}|null;peakChat?:{value:number;at:number}|null};streams:number;durationMinutes:number;attendees:number;messages:number;donations:number;totals:Record<string,string>}
// Returning to Overview reuses its compact snapshot. Explicit/timed refresh still reads fresh data.
const overviews=new Map<string,{value?:OverviewTotals;until:number;pending:boolean;task:Promise<OverviewTotals>}>();
const overviewSnapshots=new Map<string,OverviewTotals>();
export function cachedOverview(profile:string){
 const id=JSON.stringify([profile,getDataRevision(profile),getServerRevision(profile,'overview')]);
 return overviews.get(id)?.value??overviewSnapshots.get(JSON.stringify([profile,getDataRevision(profile)]));
}
export function loadOverview(profile:string,force=false){
 const id=JSON.stringify([profile,getDataRevision(profile),getServerRevision(profile,'overview')]),prior=overviews.get(id);
 if(prior&&(prior.pending||(!force&&prior.until>Date.now())))return prior.task;
 const entry:{value?:OverviewTotals;until:number;pending:boolean;task:Promise<OverviewTotals>}={...(prior?.value?{value:prior.value}:{}),until:0,pending:true,task:undefined as unknown as Promise<OverviewTotals>};
 const snapshot=JSON.stringify([profile,getDataRevision(profile)]);
 entry.task=api<OverviewTotals>('overview',undefined,undefined,profile).then(value=>{entry.value=value;entry.pending=false;if(overviews.get(id)===entry&&id===JSON.stringify([profile,getDataRevision(profile),getServerRevision(profile,'overview')])){overviewSnapshots.delete(snapshot);overviewSnapshots.set(snapshot,value);while(overviewSnapshots.size>8)overviewSnapshots.delete(overviewSnapshots.keys().next().value!);}entry.until=getServerRevision(profile,'overview')?Infinity:Date.now()+60000;return value;}).catch(error=>{if(overviews.get(id)===entry)overviews.delete(id);throw error;});
 overviews.delete(id);overviews.set(id,entry);
 while(overviews.size>8)overviews.delete(overviews.keys().next().value!);
 return entry.task;
}
function snapshotKey(profile:string,q:URLSearchParams){
 const params=new URLSearchParams(q);
 // The landing report moves with the clock, while its historical facts stay the same.
 if(params.has('_period')){
  const period=params.get('_period');params.delete('_period');
  if(period==='all')params.delete('to');
  else if(period==='7'||period==='30'){params.delete('from');params.delete('to');params.set('period',period);}
 }
 params.sort();return JSON.stringify([profile,params.toString()]);
}
function key(profile:string,q:URLSearchParams){return JSON.stringify([snapshotKey(profile,q),(['7','30'].includes(q.get('_period')??'')?[q.get('from'),q.get('to')]:null),getDataRevision(profile),getServerRevision(profile,q.get('session')?'stream:'+q.get('session'):'report')]);}
export function cachedAnalytics(profile:string,q:URLSearchParams){return reports.get(key(profile,q))?.value??snapshots.get(snapshotKey(profile,q));}
export function clearAnalyticsCache(){clearScreenData();for(const entry of reports.values())entry.controller.abort();reports.clear();snapshots.clear();overviews.clear();overviewSnapshots.clear();clearSubscriberCache();}
export function loadAnalytics(profile:string,q:URLSearchParams,force=false,signal?:AbortSignal){
 if(signal?.aborted)return Promise.reject(signal.reason);
 const id=key(profile,q),prior=reports.get(id);
 if(prior&&!prior.controller.signal.aborted&&(prior.pending||(!force&&prior.until>Date.now())))return useReport(prior,signal);
 const entry:SharedReport<any>&{value?:any;until:number}={value:prior?.value,until:0,pending:true,users:0,controller:new AbortController(),task:undefined as unknown as Promise<any>};
 entry.task=(async()=>{
  const request=new URLSearchParams(q);request.delete('_period');
  const result=await analyticsReport(signal=>api(`analytics?${request}`,undefined,signal,profile),entry.controller.signal);
  if(result.filters&&['category','source','timezone'].some(field=>result.filters[field]!==q.get(field)))throw new Error('Сервер вернул данные для других фильтров. Повторите обновление.');
  entry.pending=false;entry.value=result;const snapshot=snapshotKey(profile,q);snapshots.delete(snapshot);snapshots.set(snapshot,result);while(snapshots.size>8)snapshots.delete(snapshots.keys().next().value!);entry.until=getServerRevision(profile,q.get('session')?'stream:'+q.get('session'):'report')?Infinity:Date.now()+60000;return result;
 })().catch(error=>{if(reports.get(id)===entry)reports.delete(id);throw error;});
 reports.delete(id);reports.set(id,entry);
 while(reports.size>8){const oldest=reports.keys().next().value!;reports.get(oldest)!.controller.abort();reports.delete(oldest);}
 return useReport(entry,signal);
}
export function summaryQuery(from:number,to:number,source:string,category:string,timezone:string,resolution:number,sort:string){
 return new URLSearchParams({from:String(from),to:String(to),source,category,timezone,mode:'summary',insights:'1',clockCompact:'1',clockDay:'all',clockResolution:String(resolution),audienceOffset:'0',audienceSearch:'',audienceSort:sort,audienceCoreOnly:'0'});
}
