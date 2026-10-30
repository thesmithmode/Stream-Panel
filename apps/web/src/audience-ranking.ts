export type RankMetric = 'observedMinutes' | 'messages' | 'estimatedChatMinutes';
export interface RankPerson {id:string;name:string;observedMinutes?:number;messages?:number;estimatedChatMinutes?:number;activityMinutes?:number;accounts?:Array<{source:string;name:string}>;donations?:Record<string,string>;core?:boolean;intervals?:Array<{from:number;to:number;kind:string}>;}
export function audienceRanking(people:RankPerson[],metric:RankMetric) {
 return people.filter(person=>Number.isFinite(person[metric])&&(person[metric]??0)>0)
  .slice().sort((a,b)=>(b[metric]??0)-(a[metric]??0)||a.name.localeCompare(b.name,'ru')||a.id.localeCompare(b.id));
}

/** Unified presence is a signal, not confirmed video watch time. */
export function presenceMinutes(person:RankPerson):number {
 if(person.activityMinutes!==undefined&&Number.isFinite(person.activityMinutes))return person.activityMinutes;
 if(!person.intervals?.length)return (person.observedMinutes??0)+(person.estimatedChatMinutes??0);
 const spans=person.intervals.filter(s=>s.to>s.from).slice().sort((a,b)=>a.from-b.from);
 let end=-Infinity,total=0;
 for(const span of spans){total+=Math.max(0,span.to-Math.max(end,span.from));end=Math.max(end,span.to);}
 return total/60000;
}
export function rankTable(people:RankPerson[],metric:string,descending=true):RankPerson[]{
 const direction=descending?-1:1;
 return people.slice().sort((a,b)=>{
  let comparison=0;
  if(metric==='name')comparison=a.name.localeCompare(b.name,'ru');
  else if(metric.startsWith('donation:')){const currency=metric.slice(9),difference=BigInt(a.donations?.[currency]??'0')-BigInt(b.donations?.[currency]??'0');comparison=difference>0n?1:difference<0n?-1:0;}
  else comparison=(metric==='presence'?presenceMinutes(a):a.messages??0)-(metric==='presence'?presenceMinutes(b):b.messages??0);
  return direction*comparison||a.name.localeCompare(b.name,'ru')||a.id.localeCompare(b.id);
 });
}
export function intervalRows(intervals:NonNullable<RankPerson['intervals']>){
 const ends=new Map<string,number>();
 return intervals.filter(s=>s.to>s.from).slice().sort((a,b)=>a.from-b.from||a.kind.localeCompare(b.kind)).map(span=>{
  const previous=ends.get(span.kind);ends.set(span.kind,Math.max(previous??0,span.to));
  return {...span,gap:previous===undefined?0:Math.max(0,span.from-previous)};
 });
}
type Account=NonNullable<RankPerson['accounts']>[number];
const platforms=(accounts:RankPerson['accounts'])=>{
 const seen=new Set<string>();
 return (accounts??[]).filter(a=>(a.source==='twitch'||a.source==='youtube')&&a.name&&!seen.has(`${a.source}\n${a.name}`)&&seen.add(`${a.source}\n${a.name}`));
};
/** Platform nicknames under a group name: only when they add something to the name. */
export function platformNicknames(person:RankPerson):Account[] {
 const accounts=platforms(person.accounts);
 return accounts.length>1||(accounts.length===1&&accounts[0]!.name!==person.name)?accounts:[];
}
/** Interval group label: platform, its nicknames in this group, and whether time is an estimate. */
export function intervalSource(kind:string,accounts:RankPerson['accounts']):{platform:'Twitch'|'YouTube';nick:string;estimate:boolean}{
 const source=kind==='observed'?'twitch':'youtube';
 return {platform:source==='twitch'?'Twitch':'YouTube',nick:platforms(accounts).filter(a=>a.source===source).map(a=>a.name).join(', '),estimate:source==='youtube'};
}
export function durationLabel(minutes:number):string {
 const rounded=Math.max(0,Math.round(minutes));
 return rounded>=60?`${Math.floor(rounded/60)} ч${rounded%60?` ${rounded%60} мин`:''}`:`${rounded} мин`;
}
