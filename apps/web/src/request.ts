export class ConnectionError extends Error {
 constructor(){super('Нет связи с сервером. Данные обновятся после восстановления соединения.');this.name='ConnectionError';}
}
/** Only reads retry automatically: mutations must never be replayed after an uncertain response. */
export async function requestJson<T>(url:string,options:RequestInit={},fetcher:typeof fetch=fetch,wait:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))):Promise<T>{
 const retries=options.method===undefined||options.method==='GET'?3:1;
 for(let attempt=0;attempt<retries;attempt++){
  let response:Response;
  try{response=await fetcher(url,{...options,signal:options.signal??AbortSignal.timeout(12000)});}
  catch{if(attempt+1===retries)throw new ConnectionError();await wait(250*(attempt+1));continue;}
  if([408,429,502,503,504].includes(response.status)){
   if(attempt+1===retries){
    let data:any;try{data=await response.json();}catch{throw new ConnectionError();}
    if(data?.error)throw new Error(data.error);throw new ConnectionError();
   }
   await wait(250*(attempt+1));continue;
  }
  let data:any;
  try{data=await response.json();}catch{throw new ConnectionError();}
  if(!response.ok)throw new Error(data.error||`HTTP_${response.status}`);
  return data as T;
 }
 throw new ConnectionError();
}
