import {matchesActivityDay} from './time-audience.js';
export const clockMetrics=['viewers','twitchViewers','youtubeViewers','messages','twitchMessages','youtubeMessages','donations'] as const;
export type ClockMetric=typeof clockMetrics[number];
export type ClockViewMetric=ClockMetric|'watchHours'|'twitchWatchHours'|'youtubeWatchHours';
type Signal={at:number;isBreak?:boolean;viewersPartial?:boolean}&Partial<Record<ClockMetric,number|null>>;
export interface ClockActivity {day:string;minute:number;totals:number[];durations:number[]}
/** Preserve numerators and exposure so merging streams never averages averages. */
export function clockActivity(points:Signal[],windows:{from:number;to:number}[],timezone:string):ClockActivity[]{
 const rows=new Map<string,ClockActivity>();
 const clock=new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 for(const point of points){
  if(point.isBreak)continue;
  const duration=windows.reduce((n,w)=>n+Math.max(0,Math.min(point.at+60000,w.to)-Math.max(point.at,w.from)),0);
  if(!duration)continue;
  const parts=clock.formatToParts(point.at),day=parts.find(p=>p.type==='weekday')!.value,minute=Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value),key=`${day}:${minute}`;
  let row=rows.get(key);if(!row){row={day,minute,totals:Array(clockMetrics.length).fill(0),durations:Array(clockMetrics.length).fill(0)};rows.set(key,row);}
  clockMetrics.forEach((metric,i)=>{const value=metric==='donations'?(point.donations??0):point[metric];if(value==null||(metric==='viewers'&&point.viewersPartial))return;row!.totals[i]!+=metric.endsWith('Messages')||metric==='messages'||metric==='donations'?value:value*duration;row!.durations[i]!+=duration;});
 }
 return [...rows.values()];
}
export function mergeClockActivity(rows:ClockActivity[],merged=new Map<string,ClockActivity>()):ClockActivity[]{
 for(const row of rows){const key=`${row.day}:${row.minute}`,prior=merged.get(key);if(prior){row.totals.forEach((n,i)=>prior.totals[i]=(prior.totals[i]??0)+n);row.durations.forEach((n,i)=>prior.durations[i]=(prior.durations[i]??0)+n);}else merged.set(key,{...row,totals:[...row.totals],durations:[...row.durations]});}
 return [...merged.values()];
}
export function clockActivitySeries(rows:ClockActivity[],metric:ClockViewMetric,resolution:number,day='all'){
 const watchMetrics:Partial<Record<ClockViewMetric,ClockMetric>>={watchHours:'viewers',twitchWatchHours:'twitchViewers',youtubeWatchHours:'youtubeViewers'};
 const watchMetric=watchMetrics[metric];
 const step=[1,5,15,30,60].includes(resolution)?resolution:60,index=clockMetrics.indexOf(watchMetric??metric as ClockMetric),messages=metric==='messages'||metric.endsWith('Messages')||metric==='donations';
 const buckets=Array.from({length:1440/step},(_,i)=>({minute:i*step,total:0,duration:0}));
 for(const row of rows){if(!matchesActivityDay(day,row.day))continue;const bucket=buckets[Math.floor(row.minute/step)]!;bucket.total+=row.totals[index]??0;bucket.duration+=row.durations[index]??0;}
 return buckets.map(b=>({...b,value:b.duration?(watchMetric?b.total/3600000:b.total/b.duration*(messages?3600000:1)):null}));
}
