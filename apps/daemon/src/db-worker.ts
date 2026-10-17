import {parentPort,workerData} from 'node:worker_threads';
import {isStoreMethod,invalidatesCachedReads} from './store-contract.js';
import {StreamStore} from '../../../packages/core/src/store.js';
const initial=String(workerData.clientId??'legacy'),path=String(workerData.path);
const stores=new Map<string,StreamStore>([[initial,new StreamStore(path,workerData.profile)]]);
parentPort!.on('message',async({id,method,args,clientId=workerData.clientId?'':initial,open,profile}:{id:number;method:string;args:unknown[];clientId?:string;open?:boolean;profile?:string})=>{
 if(open){
  try{stores.set(clientId,new StreamStore(path,profile));parentPort!.postMessage({clientId,ready:true});}
  catch(error){parentPort!.postMessage({clientId,ready:true,error:error instanceof Error?error.message:'DB_ERROR'});}return;
 }
 try{
  if(!isStoreMethod(method))throw new Error('UNKNOWN_OPERATION');
  const store=stores.get(clientId);if(!store)throw new Error('DB_WORKER_STOPPED');
  const fn=(store as unknown as Record<string,(...args:unknown[])=>unknown>)[method]!;
  const started=performance.now();
  let result:unknown;
  try{result=await fn.apply(store,args);}
  finally{
   // All clients sharing this worker must observe writes before their next cache hit.
   if(invalidatesCachedReads(method,args))for(const id of stores.keys())parentPort!.postMessage({clientId:id,invalidate:true});
  }
  const executionMs=performance.now()-started;
  if(method==='close')stores.delete(clientId);
  parentPort!.postMessage({clientId,id,result,executionMs});
 }catch(error){parentPort!.postMessage({clientId,id,error:error instanceof Error?error.message:'DB_ERROR'});}
});
parentPort!.postMessage({clientId:initial,ready:true});
