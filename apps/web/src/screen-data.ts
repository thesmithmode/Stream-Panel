import {api,getProfile,getDataRevision,getServerRevision} from './api';
const entries=new Map<string,{value:any;bytes:number}>();let bytes=0,generation=0;
export function clearScreenData(){generation++;entries.clear();bytes=0;}
export function screenData<T=any>(path:string,domain:string,signal?:AbortSignal,force=false):Promise<T>{
 const epoch=generation,profile=getProfile(),revision=getDataRevision(profile),server=getServerRevision(profile,domain),key=JSON.stringify([profile,domain,path,getDataRevision(profile),getServerRevision(profile,domain)]);
 const prior=entries.get(key);if(prior&&!force)return Promise.resolve(prior.value);
 return api<T>(path,undefined,signal,profile).then(value=>{if(signal?.aborted||epoch!==generation||revision!==getDataRevision(profile)||server!==getServerRevision(profile,domain))return value;
 const size=JSON.stringify(value).length*2;if(size>1048576)return value;
 bytes-=entries.get(key)?.bytes??0;entries.delete(key);
 while(entries.size>=32||bytes+size>4194304){const first=entries.keys().next().value!;bytes-=entries.get(first)!.bytes;entries.delete(first);}
 entries.set(key,{value,bytes:size});bytes+=size;return value;});
}
