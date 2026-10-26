export class ConnectionError extends Error {
 constructor(){super('Не удалось получить данные с сервера.');this.name='ConnectionError';}
}
/** Only reads retry automatically: mutations must never be replayed after an uncertain response. */
export async function requestJson<T>(url:string,options:RequestInit&{timeoutMs?:number;conditional?:{etag:string;value:T};onResponse?:(response:Response,value:T)=>void}={},fetcher:typeof fetch=fetch,wait:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))):Promise<T>{
 const {timeoutMs=12000,conditional,onResponse,...requestOptions}=options;
 const retries=options.method===undefined||options.method==='GET'?3:1;
 for(let attempt=0;attempt<retries;attempt++){
  options.signal?.throwIfAborted();
  let response:Response;
  try{response=await fetcher(url,{cache:'no-store',...requestOptions,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});}
  catch{options.signal?.throwIfAborted();if(attempt+1===retries)throw new ConnectionError();await wait(250*(attempt+1));continue;}
  if([408,429,502,503,504].includes(response.status)){
   if(attempt+1===retries){
    let data:any;try{data=await response.json();}catch{throw new ConnectionError();}
    if(data?.error)throw new Error(data.error);throw new ConnectionError();
   }
   await wait(250*(attempt+1));continue;
  }
  if(response.status===304&&conditional)return conditional.value;
  let data:any;
  try{data=await response.json();}catch{throw new ConnectionError();}
  if(!response.ok)throw new Error(data.error||`HTTP_${response.status}`);
  onResponse?.(response,data as T);
  return data as T;
 }
 throw new ConnectionError();
}
