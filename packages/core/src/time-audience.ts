import {dateTimeFormatter} from './date-time-formatter.ts';
export interface Window {from:number;to:number;session:string}
export interface TimePerson {id:string;name:string;sources?:string[];source?:string;intervals:Window[];messageMinutes?:{session:string;at:number}[];core?:boolean;follower?:boolean|null}
export interface TimeBucket {
 minute:number;
 streams:Set<string>;
 people:Map<string,Set<string>>;
 airtimeMs:number;
 personTimeMs:number;
 averageAudience:number|null;
}
const weekendDays=new Set(['сб','вс']);
export function matchesActivityDay(filter:string,weekday:string):boolean {
 if(filter==='all')return true;
 if(filter==='weekdays')return !weekendDays.has(weekday);
 if(filter==='weekends')return weekendDays.has(weekday);
 return filter===weekday;
}
/** Merge by logical stream so linked platforms, messages and repeated spans count once. */
function unionBySession(spans:readonly Window[]):Map<string,Window[]> {
 const result=new Map<string,Window[]>();
 for(const span of [...spans].filter(s=>s.to>s.from).sort((a,b)=>a.session.localeCompare(b.session)||a.from-b.from||a.to-b.to)) {
  const windows=result.get(span.session)??[],last=windows.at(-1);
  if(last&&span.from<=last.to)last.to=Math.max(last.to,span.to);
  else windows.push({...span});
  result.set(span.session,windows);
 }
 return result;
}
/** Duration-weighted active audience; attendance still counts distinct overlapping streams. */
export function timeAudience(windows:Window[],people:TimePerson[],timezone='Europe/Moscow',resolution=60,day='all',hour:number|null=null){
 const step=[1,5,15,30,60].includes(resolution)?resolution:60;
 const buckets=new Map<number,TimeBucket>();
 for(let minute=hour===null?0:hour*60;minute<(hour===null?1440:(hour+1)*60);minute+=step)
  buckets.set(minute,{minute,streams:new Set(),people:new Map(),airtimeMs:0,personTimeMs:0,averageAudience:null});
 const formatter=dateTimeFormatter('ru-RU',{timeZone:timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const clocks=new Map<number,{day:string;minute:number}>();
 function clock(at:number){
  const key=Math.floor(at/60000);let value=clocks.get(key);
  if(!value){const parts=formatter.formatToParts(at);value={day:parts.find(p=>p.type==='weekday')!.value,minute:Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value)};clocks.set(key,value);}
  return value;
 }
 function visit(span:Window,fn:(bucket:TimeBucket,durationMs:number)=>void){
  for(let at=span.from;at<span.to;){
   const local=clock(at),bucket=buckets.get(Math.floor(local.minute/step)*step);
   // Skip unselected hours without expanding the whole history minute by minute.
   const jump=hour!==null&&Math.floor(local.minute/60)!==hour?60-local.minute%60:step-local.minute%step;
   const end=Math.min(span.to,(Math.floor(at/60000)+jump)*60000);
   if(bucket&&matchesActivityDay(day,local.day))fn(bucket,end-at);
   at=end;
  }
 }
 const bySession=unionBySession(windows);
 for(const spans of bySession.values())for(const span of spans)
  visit(span,(bucket,duration)=>{bucket.streams.add(span.session);bucket.airtimeMs+=duration;});
 for(const person of people){
  const signals=unionBySession([...person.intervals,...(person.messageMinutes??[]).map(m=>({session:m.session,from:m.at,to:m.at+60000}))]);
  for(const [session,spans] of signals)for(const span of spans)for(const window of bySession.get(session)??[]){
   const clipped={session,from:Math.max(span.from,window.from),to:Math.min(span.to,window.to)};
   visit(clipped,(bucket,duration)=>{
    const sessions=bucket.people.get(person.id)??new Set<string>();sessions.add(session);bucket.people.set(person.id,sessions);
    bucket.personTimeMs+=duration;
   });
  }
 }
 for(const bucket of buckets.values())bucket.averageAudience=bucket.airtimeMs?bucket.personTimeMs/bucket.airtimeMs:null;
 return [...buckets.values()];
}
export const clockLabel=(minute:number)=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
/** Resolve calendar midnight in the selected timezone, including offset changes. */
export function localDateWindow(day:string,timezone:string):{from:number;to:number}{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('INVALID_DATE');
 const [year,month,date]=day.split('-').map(Number) as [number,number,number];
 const calendar=Date.UTC(year,month-1,date);if(new Date(calendar).toISOString().slice(0,10)!==day)throw new Error('INVALID_DATE');
 const clock=dateTimeFormatter('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const midnight=(target:number)=>{let at=target;for(let i=0;i<3;i++){const parts=Object.fromEntries(clock.formatToParts(at).map(p=>[p.type,p.value]));const asUTC=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute));const next=target-(asUTC-at);if(next===at)return at;at=next;}return at;};
 return {from:midnight(calendar),to:midnight(calendar+86400000)};
}

export interface TimeAudienceSummary {day:string;resolution:number;minute:number;streams:number;airtimeMs:number;personTimeMs:number;averageAudience:number|null;people:{id:string;visits:number}[];peopleDeferred?:boolean}
