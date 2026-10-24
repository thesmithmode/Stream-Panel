export type ViewerPlatform='all'|'twitch'|'youtube';
export interface StreamMetric {
 id?:string; startedAt:number; endedAt?:number; durationMs?:number; messages?:number; meanChatters?:number|null; categories?:string[];
 viewers?:Partial<Record<ViewerPlatform|'known',{mean?:number|null;knownMinutes?:number;partialMinutes?:number}>>;
}
export function onlineMetric(stream:StreamMetric,platform:ViewerPlatform='all'){
 return platform==='all'?(stream.viewers?.known??stream.viewers?.all):stream.viewers?.[platform];
}
export function dailyMetrics(streams:StreamMetric[],timezone:string,platform:ViewerPlatform='all'){
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
 const groups=new Map<string,{date:string;streams:StreamMetric[];onlineTotal:number;onlineMinutes:number;activeTotal:number;activeMs:number;partial:boolean}>();
 for(const stream of [...streams].sort((a,b)=>a.startedAt-b.startedAt)){
  const date=formatter.format(stream.startedAt),row=groups.get(date)??{date,streams:[],onlineTotal:0,onlineMinutes:0,activeTotal:0,activeMs:0,partial:false};
  row.streams.push(stream);
  const duration=stream.durationMs??Math.max(0,(stream.endedAt??stream.startedAt)-stream.startedAt);
  const online=onlineMetric(stream,platform),minutes=online?.knownMinutes??duration/60000;
  if(online?.mean!=null&&Number.isFinite(online.mean)&&minutes>0){row.onlineTotal+=online.mean*minutes;row.onlineMinutes+=minutes;row.partial||=!!online.partialMinutes;}
  if(stream.messages!=null&&Number.isFinite(stream.messages)&&duration>0){row.activeTotal+=stream.messages;row.activeMs+=duration;}
  groups.set(date,row);
 }
 return [...groups.values()].map(row=>({...row,online:row.onlineMinutes?row.onlineTotal/row.onlineMinutes:null,active:row.activeMs?row.activeTotal*3600000/row.activeMs:null}));
}
/** A tie retains the first achievement; an unmeasured value never becomes a record. */
export function streamRecords(streams:StreamMetric[]){
 const sorted=[...streams].sort((a,b)=>a.startedAt-b.startedAt||(a.id??'').localeCompare(b.id??''));
 const best=(read:(stream:StreamMetric)=>number|null|undefined)=>{
  let result:{value:number;at:number}|null=null;
  for(const stream of sorted){const value=read(stream);if(value!=null&&Number.isFinite(value)&&(!result||value>result.value))result={value,at:stream.startedAt};}
  return result;
 };
 return {online:best(s=>onlineMetric(s)?.mean),messages:best(s=>s.messages)};
}
