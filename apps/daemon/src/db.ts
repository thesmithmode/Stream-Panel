import {type StoreRequest,type StoreResult,isStoreMethod} from "./store-contract.js";
import {readCacheKey} from "./read-cache-key.js";
import {StorageGuard} from "./storage-guard.js";
import {ReadCache,cachedReads,uncachedReads} from "./read-cache.js";
import type { Worker } from "node:worker_threads";
import {acquireStoreWorker} from "./store-worker-pool.js";
export class StoreClient {
  private worker: Worker;
  private analyticsClient:StoreClient|undefined;
  private analyticsRestart:Promise<StoreClient>|undefined;
  private lease:ReturnType<typeof acquireStoreWorker>;
  private detach=()=>{};
  private stopTask:Promise<void>|undefined;
  private cache=new ReadCache();
  private storage:StorageGuard;
  setStorageCleanup(cleanup:()=>Promise<void>){this.storage.setCleanup(cleanup);}
  storageStatus(){return this.storage.status();}
  private readonly timings = new Map<string, {calls:number;maxQueueMs:number;maxExecutionMs:number}>();
  queueStatus():{pending:number;operations:Record<string,{calls:number;maxQueueMs:number;maxExecutionMs:number}>}{const analytics=this.analyticsClient?.queueStatus();return {pending:this.pending.size+(analytics?.pending??0),operations:{...Object.fromEntries(this.timings),...analytics?.operations}};}
  private readonly changeListeners=new Set<()=>void>();
  onChange(listener:()=>void){this.changeListeners.add(listener);return ()=>{this.changeListeners.delete(listener);};}
  private sequence = 0;
  private dead = false;
  private stopping=false;
  private onFatal:((error:Error)=>void)|undefined;
  setFatalHandler(handler:(error:Error)=>void){this.onFatal=handler;if(this.dead&&!this.stopping)handler(new Error("DB_WORKER_STOPPED"));}
  private fatal(error:Error){const first=!this.dead;this.dead=true;this.cache.invalidate();if(first&&!this.stopping)this.onFatal?.(error);}
  private pending = new Map<
    number,
    { resolve: (value: unknown, executionMs?:number) => void; reject: (error: Error) => void }
  >();
  readonly ready: Promise<void>;
  // Worker progress, shared by every client of the worker: any message proves it is alive,
  // and pickup notices tell which requests are executing right now.
  private lastProgress=0;
  private readonly executing=new Map<string,string>();
  private watchdog:ReturnType<typeof setTimeout>|undefined;
  constructor(private readonly path: string, private readonly profile?: string, private readonly requestTimeoutMs=60000,private readonly lane='facts',acquire:typeof acquireStoreWorker=acquireStoreWorker) {
    this.storage=new StorageGuard(path);
    this.lease=acquire(path,profile,lane);this.worker=this.lease.worker;
    this.ready = new Promise((resolve, reject) => {
      const onMessage=(message:{clientId?:string;ready?:boolean;started?:boolean;method?:string;error?:string;invalidate?:boolean;id:number;result?:unknown;executionMs?:number}) => {
        this.lastProgress=performance.now();
        if(message.started)this.executing.set(`${message.clientId}:${message.id}`,String(message.method));
        else if(!message.ready&&!message.invalidate)this.executing.delete(`${message.clientId}:${message.id}`);
        this.armWatchdog();
        if(message.started||message.clientId!==this.lease.clientId)return;
        if(message.invalidate){this.cache.invalidate();this.analyticsClient?.cache.invalidate();for(const listener of this.changeListeners)listener();return;}
        if (message.ready) {
          if(message.error)reject(new Error(message.error));else resolve();
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        this.armWatchdog();
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result,message.executionMs);
      };
      const onError=(error:Error) => {
        this.fatal(error);
        reject(error);
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        this.armWatchdog();
      };
      const onExit=() => {
        this.fatal(new Error("DB_WORKER_STOPPED"));
        reject(new Error("DB_WORKER_STOPPED"));
        for (const p of this.pending.values())
          p.reject(new Error("DB_WORKER_STOPPED"));
        this.pending.clear();
        this.armWatchdog();
      };
      this.worker.on('message',onMessage);this.worker.on('error',onError);this.worker.on('exit',onExit);
      this.detach=()=>{this.worker.off('message',onMessage);this.worker.off('error',onError);this.worker.off('exit',onExit);};
      if(!this.lease.first)this.worker.postMessage({clientId:this.lease.clientId,open:true,profile});
    });
  }
  async call<Request extends StoreRequest>(...request:Request): Promise<StoreResult<Request[0]>> {
    type T = StoreResult<Request[0]>;
    const [method,...args]=request;
    if(!isStoreMethod(method))throw new Error("UNKNOWN_OPERATION");
    await this.ready;
    if(this.dead||(this.stopping&&method!=="close"))throw new Error("DB_WORKER_STOPPED");
    if(this.lane==='facts'&&this.path!==':memory:'&&['analytics','insights','clockAudience','warmAnalytics','advanceAnalytics','channelOverview','followerChanges','followingAnalytics'].includes(method)){
      const analytics=await this.analyticalClient();
      return analytics.call(...request);
    }
    if(cachedReads.has(method))return this.cache.read(readCacheKey(method,args),()=>this.execute<T>(method,...args),['analytics','followerChanges','followingAnalytics'].includes(method)?{ttlMs:86400000,compressed:true}:undefined);
    if(uncachedReads.has(method))return this.execute<T>(method,...args);
    if(method!=="close")await this.storage.check();
    // The worker invalidates every same-profile client only after facts actually change.
    return this.execute<T>(method,...args);
  }
  private async analyticalClient():Promise<StoreClient>{
    const current=this.analyticsClient;
    if(!current)return this.analyticsClient=new StoreClient(this.path,this.profile,this.requestTimeoutMs,'analytics');
    if(!current.dead)return current;
    if(!this.analyticsRestart)this.analyticsRestart=(async()=>{
      await current.stop();
      if(this.stopping)throw new Error("DB_WORKER_STOPPED");
      return this.analyticsClient=new StoreClient(this.path,this.profile,this.requestTimeoutMs,'analytics');
    })().finally(()=>{this.analyticsRestart=undefined;});
    return this.analyticsRestart;
  }
  /**
   * A stuck synchronous SQLite operation cannot be cancelled individually, so a worker that
   * makes no progress while this client waits is failed into the existing service
   * restart/recovery path. The deadline restarts with every reply or pickup on the shared
   * worker, so time spent queued behind other requests that do complete is never counted;
   * a running database copy is allowed at least 10 minutes.
   */
  private armWatchdog(){
    if(this.watchdog!==undefined){clearTimeout(this.watchdog);this.watchdog=undefined;}
    if(this.dead||!this.pending.size)return;
    const limit=[...this.executing.values()].includes('backup')?Math.max(this.requestTimeoutMs,600000):this.requestTimeoutMs;
    const remaining=this.lastProgress+limit-performance.now();
    if(remaining>0){this.watchdog=setTimeout(()=>this.armWatchdog(),remaining);return;}
    this.fatal(new Error('DB_WORKER_TIMEOUT'));
    void this.worker.terminate();
  }
  private async execute<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    if (this.dead) throw new Error("DB_WORKER_STOPPED");
    if (this.pending.size >= 10_000) throw new Error("QUEUE_OVERFLOW");
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const started=performance.now();
      // Waiting starts now; an idle worker must pick the request up within the deadline.
      if(!this.pending.size)this.lastProgress=started;
      this.pending.set(id, {
        resolve:(value,executionMs=0)=>{
          const stats=this.timings.get(method)??{calls:0,maxQueueMs:0,maxExecutionMs:0};
          stats.calls++;
          stats.maxQueueMs=Math.max(stats.maxQueueMs,Math.max(0,performance.now()-started-executionMs));
          stats.maxExecutionMs=Math.max(stats.maxExecutionMs,executionMs);
          this.timings.set(method,stats);
          resolve(value as T);
        },
        reject,
      });
      this.armWatchdog();
      try {
        this.worker.postMessage({clientId:this.lease.clientId,id,method,args});
      } catch (error) {
        this.pending.get(id)!.reject(error instanceof Error?error:new Error(String(error)));
        this.pending.delete(id);
        this.armWatchdog();
      }
    });
  }
  stop():Promise<void>{return this.stopTask??=this.stopClient();}
  private async stopClient(): Promise<void> {
    this.stopping=true;
    this.cache.close();
    await this.analyticsRestart?.catch(()=>{});
    await this.analyticsClient?.stop();
    try { if(!this.dead)await this.call("close"); }
    finally {this.dead=true;this.armWatchdog();this.detach();await this.lease.release();}
  }
}
