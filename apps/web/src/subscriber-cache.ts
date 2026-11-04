import {api,getDataRevision,getServerRevision} from './api';
import type {StreamStore} from '../../../packages/core/src/store';
type Report=ReturnType<StreamStore['subscriberHistory']>;
export type SubscriberScope={profile:string;timezone:string;from:number;to:number;liveEnd:boolean};
export type SubscriberView=SubscriberScope&{twitch:Report;youtube:Report};
type Entry={activityRevision:string;controller:AbortController;promise:Promise<SubscriberView>;value?:SubscriberView;until:number};
const cache=new Map<string,Entry>();
export function subscriberScope(profile:string,from:number,to:number,timezone:string,liveEnd=false):SubscriberScope{
 return {profile,from,to,timezone,liveEnd};
}
export function clearSubscriberCache(profile?:string){
 for(const [key,entry] of cache)if(!profile||JSON.parse(key)[0].profile===profile){entry.controller.abort();cache.delete(key);}
}
export function subscriberPeriod(scope:SubscriberScope){
 // Activity can advance an all-time report's end without changing any subscriber facts.
 const key=JSON.stringify([scope.liveEnd&&scope.from===0?{...scope,to:0}:scope,getDataRevision(scope.profile),getServerRevision(scope.profile,'subscribers')]),existing=cache.get(key);
 if(existing&&(!existing.value||existing.until>Date.now())){cache.delete(key);cache.set(key,existing);return existing;}
 const controller=new AbortController(),to=Math.min(scope.to,Date.now());
 const entry:Entry={activityRevision:getServerRevision(scope.profile,'bands'),controller,until:0,...(existing?.value?{value:existing.value}:{}),promise:Promise.all((['twitch','youtube'] as const).map(source=>api<Report>(`analytics/subscribers?${new URLSearchParams({source,from:String(scope.from),to:String(to)})}`,undefined,controller.signal,scope.profile))).then(reports=>{
  const value={...scope,twitch:reports[0]!,youtube:reports[1]!};
  if(!controller.signal.aborted){entry.value=value;entry.until=getServerRevision(scope.profile,'subscribers')?Infinity:Date.now()+60000;}
  return value;
 }).catch(error=>{if(cache.get(key)===entry)cache.delete(key);throw error;})};
 cache.delete(key);cache.set(key,entry);
 if(cache.size>16){const oldest=cache.keys().next().value!;cache.get(oldest)!.controller.abort();cache.delete(oldest);}
 return entry;
}
