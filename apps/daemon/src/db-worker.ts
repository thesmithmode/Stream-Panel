import {parentPort,workerData} from 'node:worker_threads';
import {isStoreMethod,invalidatesCachedReads} from './store-contract.js';
import {StreamStore} from '../../../packages/core/src/store.js';
const initial=String(workerData.clientId??'legacy'),path=String(workerData.path);
type Entry={store:StreamStore;profile:string|undefined;stamp:number};
function openStore(profile:string|undefined):Entry{const store=new StreamStore(path,profile);return {store,profile,stamp:store.changeStamp()};}
const stores=new Map<string,Entry>([[initial,openStore(workerData.profile)]]);
function observeFacts(entry:Entry,stamp:number){
 for(const [id,peer] of stores)if(peer.profile===entry.profile&&peer.stamp!==stamp){peer.stamp=stamp;parentPort!.postMessage({clientId:id,invalidate:true});}
}
// Account groups are shared by all profiles of the file: after a write, apply them everywhere
// and let clients of every changed profile observe it before their next cache hit.
function shareIdentities(entry:Entry){
 let touched:string[];
 try{touched=entry.store.syncSharedIdentities();}
 catch(error){console.error('SHARED_IDENTITY_SYNC_FAILED',error instanceof Error?error.message:'DB_ERROR');return;}
 if(!touched.length)return;
 for(const [id,peer] of stores){
  if(peer.profile===undefined||!touched.includes(peer.profile))continue;
  const stamp=peer.store.changeStamp();
  if(peer.stamp!==stamp){peer.stamp=stamp;parentPort!.postMessage({clientId:id,invalidate:true});}
 }
}
parentPort!.on('message',async({id,method,args,clientId=workerData.clientId?'':initial,open,profile}:{id:number;method:string;args:unknown[];clientId?:string;open?:boolean;profile?:string})=>{
 if(open){
  try{const entry=openStore(profile);stores.set(clientId,entry);shareIdentities(entry);parentPort!.postMessage({clientId,ready:true});}
  catch(error){parentPort!.postMessage({clientId,ready:true,error:error instanceof Error?error.message:'DB_ERROR'});}return;
 }
 try{
  if(!isStoreMethod(method))throw new Error('UNKNOWN_OPERATION');
  const entry=stores.get(clientId);if(!entry)throw new Error('DB_WORKER_STOPPED');const {store}=entry;
  const fn=(store as unknown as Record<string,(...args:unknown[])=>unknown>)[method]!;
  const started=performance.now();
  const stamp=invalidatesCachedReads(method,args)||method==='changes'?store.changeStamp():null;
  // Version checks also observe repairs committed through another connection.
  if(stamp!==null)observeFacts(entry,stamp);
  let result:unknown;
  try{result=await fn.apply(store,args);}
  finally{
   // Clients of the same profile must observe writes before their next cache hit.
   if(stamp!==null){observeFacts(entry,store.changeStamp());shareIdentities(entry);}
  }
  const executionMs=performance.now()-started;
  if(method==='close')stores.delete(clientId);
  parentPort!.postMessage({clientId,id,result,executionMs});
 }catch(error){parentPort!.postMessage({clientId,id,error:error instanceof Error?error.message:'DB_ERROR'});}
});
parentPort!.postMessage({clientId:initial,ready:true});
