import {api} from './api';
export type ClassificationState={revision:number;canMarkBot:boolean;manualBot:boolean;knownBot:boolean;automaticHuman:boolean;manualHuman:boolean};
export async function loadClassifications(ids:string[],signal:AbortSignal,profile:string){
 const result:Record<string,ClassificationState>={};
 for(let offset=0;offset<ids.length;offset+=100)Object.assign(result,await api<Record<string,ClassificationState>>(`persons/classifications?${new URLSearchParams({ids:ids.slice(offset,offset+100).join(',')})}`,undefined,signal,profile));
 return result;
}
