import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
type Entry={worker:Worker;references:number};
const files=new Map<string,Entry>();
/** One queue per physical SQLite file. Connections, stores and RPC replies stay client-scoped. */
export function acquireStoreWorker(path:string,profile?:string,lane='facts'){
 const clientId=randomUUID(),key=path===':memory:'?clientId:`${resolve(path)}:${lane}`;
 let entry=files.get(key);const first=!entry;
 if(!entry){
  const worker=new Worker(new URL('./db-worker.js',import.meta.url),{workerData:{path,profile,clientId},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:8}});
  worker.on('error',()=>{}); // Active clients own rejection/recovery; shutdown must not emit an unhandled error.
  entry={worker,references:0};files.set(key,entry);
  worker.once('exit',()=>{if(files.get(key)?.worker===worker)files.delete(key);});
 }
 entry.references++;const lease=entry;let released=false;
 return {worker:lease.worker,clientId,first,async release(){
  if(released)return;released=true;
  if(--lease.references===0){if(files.get(key)===lease)files.delete(key);await lease.worker.terminate();}
 }};
}
