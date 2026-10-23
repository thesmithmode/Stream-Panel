import {api,getDataRevision} from './api';
import {localDateWindow} from './time-audience';
import type {StreamStore} from '../../../packages/core/src/store';
type Report=ReturnType<StreamStore['subscriberHistory']>;
export type SubscriberScope={profile:string;days:number;day:string;timezone:string;from:number;to:number};
export type SubscriberView=SubscriberScope&{twitch:Report;youtube:Report};
type Entry={controller:AbortController;promise:Promise<SubscriberView>;value?:SubscriberView;until:number};
const cache=new Map<string,Entry>();
export function subscriberScope(profile:string,days:number,day:string,timezone:string):SubscriberScope{
 return {profile,days,day,timezone,from:localDateWindow(new Date(Date.parse(day)-86400000*(days-1)).toISOString().slice(0,10),timezone).from,to:localDateWindow(day,timezone).to};
}
export function clearSubscriberCache(profile?:string){
 for(const [key,entry] of cache)if(!profile||JSON.parse(key)[0].profile===profile){entry.controller.abort();cache.delete(key);}
}
export function subscriberPeriod(scope:SubscriberScope){
 const key=JSON.stringify([scope,getDataRevision(scope.profile)]),existing=cache.get(key);
 if(existing&&(!existing.value||existing.until>Date.now())){cache.delete(key);cache.set(key,existing);return existing;}
 const controller=new AbortController(),to=Math.min(scope.to,Date.now());
 const entry:Entry={controller,until:0,...(existing?.value?{value:existing.value}:{}),promise:Promise.all((['twitch','youtube'] as const).map(source=>api<Report>(`analytics/subscribers?${new URLSearchParams({source,from:String(scope.from),to:String(to)})}`,undefined,controller.signal,scope.profile))).then(reports=>{
  const value={...scope,twitch:reports[0]!,youtube:reports[1]!};
  if(!controller.signal.aborted){entry.value=value;entry.until=Date.now()+60000;}
  return value;
 }).catch(error=>{if(cache.get(key)===entry)cache.delete(key);throw error;})};
 cache.delete(key);cache.set(key,entry);
 if(cache.size>16){const oldest=cache.keys().next().value!;cache.get(oldest)!.controller.abort();cache.delete(oldest);}
 return entry;
}
export function preloadSubscriberPeriods(profile:string,timezone:string){
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 return Promise.allSettled([7,30].map(days=>subscriberPeriod(subscriberScope(profile,days,day,timezone)).promise));
}
