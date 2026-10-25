import type {View} from './route';
export interface Changes {versions:Record<string,number>;activeStream:string|null;requestedSession?:string|null;stream:{id:string;endedAt:number|null;revision:number}|null;connectionRevision:string;dataEpoch?:string;checkedAt?:number;configRevision?:string;sync?:unknown;release?:string}
export function screenVersion(view:View,_session:string,c:Changes){
 const v=c.versions;
 const config=[c.configRevision,c.dataEpoch];
 const tick=c.activeStream&&(['overview','sessions','analytics'].includes(view)||(view==='stream'&&c.stream?.id===c.activeStream))?Math.floor((c.checkedAt??0)/60000):null;
 if(view==='connections'||view==='settings')return JSON.stringify([c.connectionRevision,c.dataEpoch]);
 if(view==='stream')return JSON.stringify([c.stream,v.people,v.donations,v.follows,config,tick]);
 if(view==='analytics')return JSON.stringify([v.activity,v.people,v.donations,v.follows,config,tick]);
 if(view==='donations')return JSON.stringify([v.donations,v.people,config]);
 if(view==='people')return JSON.stringify([v.people,v.activity,v.donations,v.follows,config,tick]);
 return JSON.stringify([v.activity,v.people,v.donations,config,tick]);
}
export function refreshInterval(preference:number,view:View,_session:string,c:Changes|null){
 if(preference>0)return preference;
 if(view==='connections'||view==='settings')return 300;
 return c?.activeStream&&(view!=='stream'||(c.stream?.id??_session)===c.activeStream)?60:300;
}
