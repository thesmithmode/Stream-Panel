import {parentPort,workerData} from 'node:worker_threads';
import {isStoreMethod,invalidatesCachedReads} from './store-contract.js';
import {StreamStore} from '../../../packages/core/src/store.js';
const initial=String(workerData.clientId??'legacy'),path=String(workerData.path);
const stores=new Map<string,{store:StreamStore;profile:string|undefined}>([[initial,{store:new StreamStore(path,workerData.profile),profile:workerData.profile}]]);
parentPort!.on('message',async({id,method,args,clientId=workerData.clientId?'':initial,open,profile}:{id:number;method:string;args:unknown[];clientId?:string;open?:boolean;profile?:string})=>{
 if(open){
  try{stores.set(clientId,{store:new StreamStore(path,profile),profile});parentPort!.postMessage({clientId,ready:true});}
  catch(error){parentPort!.postMessage({clientId,ready:true,error:error instanceof Error?error.message:'DB_ERROR'});}return;
 }
 try{
  if(!isStoreMethod(method))throw new Error('UNKNOWN_OPERATION');
  const entry=stores.get(clientId);if(!entry)throw new Error('DB_WORKER_STOPPED');const {store}=entry;
  const fn=(store as unknown as Record<string,(...args:unknown[])=>unknown>)[method]!;
  const started=performance.now();
  let result:unknown;
  try{result=await fn.apply(store,args);}
  finally{
   // Clients of the same profile must observe writes before their next cache hit.
   if(invalidatesCachedReads(method,args))for(const [id,peer] of stores)if(peer.profile===entry.profile)parentPort!.postMessage({clientId:id,invalidate:true});
  }
  const executionMs=performance.now()-started;
  if(method==='close')stores.delete(clientId);
  parentPort!.postMessage({clientId,id,result,executionMs});
 }catch(error){parentPort!.postMessage({clientId,id,error:error instanceof Error?error.message:'DB_ERROR'});}
});
parentPort!.postMessage({clientId:initial,ready:true});
