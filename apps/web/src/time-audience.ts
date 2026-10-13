export interface Window {from:number;to:number;session:string}
export interface TimePerson {id:string;name:string;sources?:string[];source?:string;intervals:Window[];messageMinutes?:{session:string;at:number}[];core?:boolean;follower?:boolean|null}
export interface TimeBucket {minute:number;streams:Set<string>;people:Map<string,Set<string>>}
/** Build only the displayed slots from the already fetched intervals; no per-person requests. */
export function timeAudience(windows:Window[],people:TimePerson[],timezone='Europe/Moscow',resolution=60,day='all',hour:number|null=null){
 const step=[1,5,15,60].includes(resolution)?resolution:60;
 const buckets=new Map<number,TimeBucket>();for(let minute=hour===null?0:hour*60;minute<(hour===null?1440:(hour+1)*60);minute+=step)buckets.set(minute,{minute,streams:new Set(),people:new Map()});
 const formatter=new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),clocks=new Map<number,{day:string;minute:number}>();
 function clock(at:number){const key=Math.floor(at/60000);let c=clocks.get(key);if(!c){const parts=formatter.formatToParts(at);c={day:parts.find(p=>p.type==='weekday')!.value,minute:Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value)};clocks.set(key,c);}return c;}
 function visit(span:Window,fn:(bucket:TimeBucket)=>void){for(let at=span.from;at<span.to;){const c=clock(at),slot=Math.floor(c.minute/step)*step,bucket=buckets.get(slot);if(bucket&&(day==='all'||day===c.day))fn(bucket);
   // Skip the rest of an unselected hour instead of expanding it into minutes.
   const jump=hour!==null&&Math.floor(c.minute/60)!==hour?60-c.minute%60:step-c.minute%step;
   at=Math.min(span.to,(Math.floor(at/60000)+jump)*60000);
 }}
 const bySession=new Map<string,Window[]>();for(const window of windows){const rows=bySession.get(window.session)??[];rows.push(window);bySession.set(window.session,rows);visit(window,b=>b.streams.add(window.session));}
 for(const person of people){const spans=[...person.intervals,...(person.messageMinutes??[]).map(m=>({session:m.session,from:m.at,to:m.at+60000}))];
  for(const span of spans)for(const window of bySession.get(span.session)??[]){const clipped={session:span.session,from:Math.max(span.from,window.from),to:Math.min(span.to,window.to)};visit(clipped,b=>{const sessions=b.people.get(person.id)??new Set<string>();sessions.add(span.session);b.people.set(person.id,sessions);});}
 }
 return [...buckets.values()];
}
export const clockLabel=(minute:number)=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
