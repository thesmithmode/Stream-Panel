/** Progress responses advance a bounded server job; abandoned callers stop polling. */
export async function analyticsReport(load:(signal:AbortSignal)=>Promise<any>,signal:AbortSignal){
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(120000)]);
 for(;;){
  deadline.throwIfAborted();
  const result=await load(deadline);
  deadline.throwIfAborted();
  if(!result.preparing)return result;
 }
}
export type SharedReport<T>={task:Promise<T>;controller:AbortController;pending:boolean;users:number};
/** One cancelled screen must not cancel a report still needed by a preloader or peer. */
export function useReport<T>(entry:SharedReport<T>,signal?:AbortSignal):Promise<T>{
 if(signal?.aborted)return Promise.reject(signal.reason);
 entry.users++;
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=()=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);entry.users--;if(!entry.users&&entry.pending)entry.controller.abort();};
  const abort=()=>{finish();reject(signal?.reason);};
  signal?.addEventListener('abort',abort,{once:true});
  entry.task.then(value=>{finish();resolve(value);},error=>{finish();reject(error);});
 });
}
