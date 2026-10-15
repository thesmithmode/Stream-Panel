import {type StoreRequest,isStoreMethod,storeOperations} from "./store-contract.js";
import {readCacheKey} from "./read-cache-key.js";
import {StorageGuard} from "./storage-guard.js";
import {ReadCache,cachedReads,uncachedReads} from "./read-cache.js";
import type { Worker } from "node:worker_threads";
import {acquireStoreWorker} from "./store-worker-pool.js";
export class StoreClient {
  private worker: Worker;
  private lease:ReturnType<typeof acquireStoreWorker>;
  private detach=()=>{};
  private stopTask:Promise<void>|undefined;
  private cache=new ReadCache();
  private storage:StorageGuard;
  setStorageCleanup(cleanup:()=>Promise<void>){this.storage.setCleanup(cleanup);}
  storageStatus(){return this.storage.status();}
  private sequence = 0;
  private dead = false;
  private stopping=false;
  private onFatal:((error:Error)=>void)|undefined;
  setFatalHandler(handler:(error:Error)=>void){this.onFatal=handler;if(this.dead&&!this.stopping)handler(new Error("DB_WORKER_STOPPED"));}
  private fatal(error:Error){const first=!this.dead;this.dead=true;this.cache.invalidate();if(first&&!this.stopping)this.onFatal?.(error);}
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly ready: Promise<void>;
  constructor(path: string, profile?: string) {
    this.storage=new StorageGuard(path);
    this.lease=acquireStoreWorker(path,profile);this.worker=this.lease.worker;
    this.ready = new Promise((resolve, reject) => {
      const onMessage=(message:{clientId?:string;ready?:boolean;error?:string;id:number;result?:unknown}) => {
        if(message.clientId!==this.lease.clientId)return;
        if (message.ready) {
          if(message.error)reject(new Error(message.error));else resolve();
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      };
      const onError=(error:Error) => {
        this.fatal(error);
        reject(error);
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
      };
      const onExit=() => {
        this.fatal(new Error("DB_WORKER_STOPPED"));
        reject(new Error("DB_WORKER_STOPPED"));
        for (const p of this.pending.values())
          p.reject(new Error("DB_WORKER_STOPPED"));
        this.pending.clear();
      };
      this.worker.on('message',onMessage);this.worker.on('error',onError);this.worker.on('exit',onExit);
      this.detach=()=>{this.worker.off('message',onMessage);this.worker.off('error',onError);this.worker.off('exit',onExit);};
      if(!this.lease.first)this.worker.postMessage({clientId:this.lease.clientId,open:true,profile});
    });
  }
  async call<T = unknown>(...request:StoreRequest): Promise<T> {
    const [method,...args]=request;
    if(!isStoreMethod(method))throw new Error("UNKNOWN_OPERATION");
    await this.ready;
    if(this.dead)throw new Error("DB_WORKER_STOPPED");
    if(cachedReads.has(method))return this.cache.read(readCacheKey(method,args),()=>this.execute<T>(method,...args));
    if(uncachedReads.has(method))return this.execute<T>(method,...args);
    if(method!=="close")await this.storage.check();
    // These operations write operational state, not facts used by cached reports.
    if(storeOperations[method]==='maintenance'||method==='collectionLifecycle'&&args[0]==='heartbeat')return this.execute<T>(method,...args);
    this.cache.invalidate();
    try{return await this.execute<T>(method,...args);}finally{this.cache.invalidate();}
  }
  private async execute<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    if (this.dead) throw new Error("DB_WORKER_STOPPED");
    if (this.pending.size >= 10_000) throw new Error("QUEUE_OVERFLOW");
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({clientId:this.lease.clientId,id,method,args});
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  stop():Promise<void>{return this.stopTask??=this.stopClient();}
  private async stopClient(): Promise<void> {
    this.stopping=true;
    this.cache.close();
    try { if(!this.dead)await this.call("close"); }
    finally {this.dead=true;this.detach();await this.lease.release();}
  }
}
