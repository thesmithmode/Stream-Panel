import {operationsWithPolicy} from "./store-contract.js";
import {serialize} from "node:v8";
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import {createClient} from 'redis';
export const READ_CACHE_TTL_MS=30000;
/** Cached results survive polling between writes; domain writes invalidate versioned keys.
 * Derived data only. SQLite remains authoritative; a Redis outage never blocks collection. */
export class ReadCache {
 private readonly prefix=`sp:${randomUUID()}:`;
 private version=0;
 private pending=new Map<string,Promise<unknown>>();
 private local=new Map<string,{until:number;value:unknown;bytes:number}>();
 private localBytes=0;
 private redis:ReturnType<typeof createClient>|undefined;
 constructor(url=process.env.STREAM_PANEL_REDIS_URL){
  if(url){try{this.redis=createClient({url,disableOfflineQueue:true,socket:{connectTimeout:300,reconnectStrategy:false}});this.redis.on('error',()=>{});void this.redis.connect().catch(()=>{});}catch{this.redis=undefined;}}
 }
 invalidate(){this.version++;this.local.clear();this.localBytes=0;this.pending.clear();}
 async read<T>(key:string,load:()=>Promise<T>,policy?:{ttlMs:number;compressed:boolean}):Promise<T>{
  const version=this.version,cacheKey=`${version}:${key}`,cached=this.local.get(cacheKey);
  if(cached&&cached.until>Date.now())return structuredClone(cached.value) as T;
  const prior=this.pending.get(cacheKey);if(prior)return structuredClone(await prior) as T;
  const task=(async()=>{
   const redisKey=this.prefix+createHash('sha256').update(cacheKey).digest('hex');
   let value:T|undefined,until=0;
   if(this.redis?.isReady){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
     const raw=await Promise.race([this.redis.get(redisKey),new Promise<null>(resolve=>{timer=setTimeout(()=>{this.redis?.destroy();this.redis=undefined;resolve(null);},100);})]);
     if(raw!==null){
      const entry=JSON.parse(raw);
      if(entry&&typeof entry.until==='number'&&entry.until>Date.now()){
       if(entry.encoding==='gzip'&&typeof entry.payload==='string'){
        value=JSON.parse(gunzipSync(Buffer.from(entry.payload,'base64'),{maxOutputLength:16_000_000}).toString());until=entry.until;
       }else if(Object.hasOwn(entry,'value')){value=entry.value;until=entry.until;}
      }
     }
    }catch{/* Read from SQLite. */}finally{clearTimeout(timer);}
   }
   if(value===undefined){value=await load();until=Date.now()+(policy?.ttlMs??READ_CACHE_TTL_MS);}
   if(value&&typeof value==='object'&&'preparing' in value&&value.preparing===true)return value;
   if(version===this.version){
    const bytes=serialize(value).byteLength;
    if(bytes<=2_000_000){
      for(const [key,entry] of this.local)if(entry.until<=Date.now()||key===cacheKey){this.local.delete(key);this.localBytes-=entry.bytes;}
      while(this.local.size>=128||this.localBytes+bytes>8_000_000){const key=this.local.keys().next().value!;this.localBytes-=this.local.get(key)!.bytes;this.local.delete(key);}
      this.local.set(cacheKey,{until,value:structuredClone(value),bytes});this.localBytes+=bytes;
    }
    if(this.redis?.isReady){
     let raw:string;
     if(policy?.compressed){
      const payload=JSON.stringify(value);
      raw=payload!==undefined&&Buffer.byteLength(payload)<=16_000_000?JSON.stringify({until,encoding:'gzip',payload:gzipSync(payload).toString('base64')}):'';
     }else raw=JSON.stringify({until,value});
     if(raw&&until>Date.now()&&Buffer.byteLength(raw)<=2_000_000)void this.redis.set(redisKey,raw,{PX:Math.max(1,until-Date.now())}).catch(()=>{});
    }
   }
   return value;
  })();
  this.pending.set(cacheKey,task);
  try{return structuredClone(await task);}finally{if(this.pending.get(cacheKey)===task)this.pending.delete(cacheKey);}
 }
 close(){this.invalidate();if(this.redis?.isOpen)this.redis.destroy();}
}
export const cachedReads=operationsWithPolicy('cached');
/** Uncached reads must not invalidate unrelated derived data. */
export const uncachedReads=operationsWithPolicy('read');
