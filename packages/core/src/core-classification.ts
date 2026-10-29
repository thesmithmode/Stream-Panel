/** One domain rule for raw, cached and aggregated reports. */
export function classifyCore(qualified:number,total:number,threshold:number,override:boolean|null){
 return override??(qualified>0&&total>0&&qualified/total*100+1e-10>=threshold);
}
export function coreSessions(ids:readonly string[],count:number){
 const unique=[...new Set(ids)].sort();
 return {coreSessionIds:unique.slice(-100),coreAttendanceCount:count,coreSessionIdsTruncated:count>100};
}

/** Retired fields are accepted, but never multiply analytical cache variants.
 * Invalid legacy input must still reach normal request validation. */
export function normalizeCoreOptions<T extends {minSessions?:unknown;minMinutes?:unknown;minMessages?:unknown;coreRule?:unknown}>(options:T):T{
 const valid=[['minSessions',1000],['minMinutes',129600],['minMessages',1000000]] as const;
 if(valid.some(([key,max])=>options[key]!==undefined&&(typeof options[key]!=='number'||!Number.isInteger(options[key])||Number(options[key])<0||Number(options[key])>max))||options.coreRule!==undefined&&!['either','both','frequency'].includes(String(options.coreRule)))return options;
 return {...options,minSessions:3,minMinutes:30,minMessages:5,coreRule:'either'};
}
