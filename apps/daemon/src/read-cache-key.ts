import {READ_CACHE_TTL_MS} from './read-cache.js';
/** Moving live/rolling windows share one bounded polling interval.
 * Historical endpoints and all non-time filters stay exact. Queries still use original args. */
export function readCacheKey(method:string,args:unknown[],now=Date.now()):string {
 const moving=(value:unknown,offset=0)=>typeof value==='number'&&Math.abs(value-(now-offset))<1000
  ?{rollingOffset:offset,tick:Math.floor(now/READ_CACHE_TTL_MS)}:value;
 const rolling=(value:unknown)=>{
  for(const days of [7,30]){
   const normalized=moving(value,days*86400000);
   if(normalized!==value)return normalized;
  }
  return value;
 };
 const key=[...args];
 if((method==='analytics'||method==='clockAudience')&&args[0]&&typeof args[0]==='object'){
  const options=args[0] as Record<string,unknown>;
  key[0]={...options,toMs:moving(options.toMs)};
 }
 if(method==='persons'||method==='personsPage')key[2]=rolling(args[2]);
 if(method==='personsTop')key[4]=rolling(args[4]);
 return JSON.stringify([method,key]);
}
