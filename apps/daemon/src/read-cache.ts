import {createHash,randomUUID} from 'node:crypto';
import {createClient} from 'redis';
/** Redis outlives the short local cache; every write invalidates both via versioned keys.
 * Derived data only. SQLite remains authoritative; a Redis outage never blocks collection. */
export class ReadCache {
 private readonly prefix=`sp:${randomUUID()}:`;
 private version=0;
 private pending=new Map<string,Promise<unknown>>();
 private local=new Map<string,{until:number;value:unknown}>();
 private redis:ReturnType<typeof createClient>|undefined;
 constructor(url=process.env.STREAM_PANEL_REDIS_URL){
  if(url){try{this.redis=createClient({url,disableOfflineQueue:true,socket:{connectTimeout:300,reconnectStrategy:false}});this.redis.on('error',()=>{});void this.redis.connect().catch(()=>{});}catch{this.redis=undefined;}}
 }
 invalidate(){this.version++;this.local.clear();this.pending.clear();}
 async read<T>(key:string,load:()=>Promise<T>):Promise<T>{
  const version=this.version,cacheKey=`${version}:${key}`,cached=this.local.get(cacheKey);
  if(cached&&cached.until>Date.now())return structuredClone(cached.value) as T;
  const prior=this.pending.get(cacheKey);if(prior)return structuredClone(await prior) as T;
  const task=(async()=>{
   const redisKey=this.prefix+createHash('sha256').update(cacheKey).digest('hex');
   let value:T|undefined;
   if(this.redis?.isReady){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
     const raw=await Promise.race([this.redis.get(redisKey),new Promise<null>(resolve=>{timer=setTimeout(()=>{this.redis?.destroy();this.redis=undefined;resolve(null);},100);})]);
     if(raw!==null)value=JSON.parse(raw);
    }catch{/* Read from SQLite. */}finally{clearTimeout(timer);}
   }
   value??=await load();
   if(version===this.version){
    if(this.local.size>=128)this.local.delete(this.local.keys().next().value!);
    this.local.set(cacheKey,{until:Date.now()+3000,value:structuredClone(value)});
    if(this.redis?.isReady){
     const raw=JSON.stringify(value);
     if(raw!==undefined&&Buffer.byteLength(raw)<=2_000_000)void this.redis.set(redisKey,raw,{PX:30000}).catch(()=>{});
    }
   }
   return value;
  })();
  this.pending.set(cacheKey,task);
  try{return structuredClone(await task);}finally{if(this.pending.get(cacheKey)===task)this.pending.delete(cacheKey);}
 }
 close(){this.invalidate();if(this.redis?.isOpen)this.redis.destroy();}
}
export const cachedReads=new Set(['persons','person','personStats','personActivity','personMetadata','personNotes','donation','donations','donationAudit','sessions','analytics','summary','personFollowing','followingAnalytics','streamMetadata','personsTop','events','merges','splits','candidatePersons']);
