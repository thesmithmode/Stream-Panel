import {operationsWithPolicy} from "./store-contract.js";
import {serialize,deserialize} from "node:v8";
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import {createClient} from 'redis';
const redisClient=(url:string)=>createClient({url,disableOfflineQueue:true,socket:{connectTimeout:300,reconnectStrategy:false}});
export const READ_CACHE_TTL_MS=30000;
/** Cached results survive polling between writes; domain writes invalidate versioned keys.
 * Derived data only. SQLite remains authoritative; a Redis outage never blocks collection. */
export class ReadCache {
 private readonly prefix=`sp:${randomUUID()}:`;
 private version=0;
 private pending=new Map<string,Promise<unknown>>();
 private local=new Map<string,{until:number;value?:unknown;payload?:Buffer;bytes:number}>();
 private localBytes=0;
 private redis:ReturnType<typeof redisClient>|undefined;
 private retryAt=0;
 private closed=false;
 constructor(private readonly url=process.env.STREAM_PANEL_REDIS_URL){this.connectRedis();}
 private disconnectRedis(){const redis=this.redis;this.redis=undefined;this.retryAt=Date.now()+5000;if(redis?.isOpen)redis.destroy();}
 private connectRedis(){
  if(this.closed||!this.url||this.redis?.isOpen||Date.now()<this.retryAt)return;
  this.disconnectRedis();
  try{const redis=redisClient(this.url);this.redis=redis;redis.on('error',()=>{});void redis.connect().catch(()=>{if(this.redis===redis)this.disconnectRedis();});}catch{this.redis=undefined;}
 }
 invalidate(){this.version++;this.local.clear();this.localBytes=0;this.pending.clear();}
 async read<T>(key:string,load:()=>Promise<T>,policy?:{ttlMs:number;compressed:boolean}):Promise<T>{
  this.connectRedis();
  const version=this.version,cacheKey=`${version}:${key}`,cached=this.local.get(cacheKey);
  if(cached&&cached.until>Date.now())return (cached.payload?deserialize(gunzipSync(cached.payload,{maxOutputLength:16_000_000})):structuredClone(cached.value)) as T;
  const prior=this.pending.get(cacheKey);if(prior)return structuredClone(await prior) as T;
  const task=(async()=>{
   const redisKey=this.prefix+createHash('sha256').update(cacheKey).digest('hex');
   let value:T|undefined,until=0;
   if(this.redis?.isReady){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
     const raw=await Promise.race([this.redis.get(redisKey),new Promise<null>(resolve=>{timer=setTimeout(()=>{this.disconnectRedis();resolve(null);},100);})]);
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
    const serialized=serialize(value);
    const payload=policy?.compressed&&serialized.byteLength>2_000_000&&serialized.byteLength<=16_000_000?gzipSync(serialized,{level:1}):undefined;
    const bytes=payload?.byteLength??serialized.byteLength;
    if(bytes<=2_000_000){
      for(const [key,entry] of this.local)if(entry.until<=Date.now()||key===cacheKey){this.local.delete(key);this.localBytes-=entry.bytes;}
      while(this.local.size>=128||this.localBytes+bytes>8_000_000){const key=this.local.keys().next().value!;this.localBytes-=this.local.get(key)!.bytes;this.local.delete(key);}
      this.local.set(cacheKey,{until,...(payload?{payload}:{value:structuredClone(value)}),bytes});this.localBytes+=bytes;
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
 close(){this.closed=true;this.invalidate();this.disconnectRedis();}
}
export const cachedReads=operationsWithPolicy('cached');
/** Uncached reads must not invalidate unrelated derived data. */
export const uncachedReads=operationsWithPolicy('read');
