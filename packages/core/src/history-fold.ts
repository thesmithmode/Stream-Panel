import {unionSpans,type audienceAnalytics} from './analytics.js';
import {HistoryTimeline,type TimelineState} from './history-timeline.js';
import {InsightAccumulator,type InsightState} from './insights.js';
import {mergeClockActivity} from './clock-activity.js';
import type {TimeAudienceSummary} from './time-audience.js';

type Report=ReturnType<typeof audienceAnalytics>;
export type HistoryPerson=Report['audience'][number]&{sessionCount:number;attendanceCount:number;activityMinutes:number;detailAvailable?:boolean};
export interface HistoryFold {
 sample:Report;
 selectedStreams:number;
 people:HistoryPerson[];
 streams:{row:Report['streamComparison'][number];visitors:string[]}[];
 categories:Report['categories'];
 categoryPeople:[string,string[]][];
 availableCategories:Report['availableCategories'];
 hours:Report['hours'];
 clock:TimeAudienceSummary[];
 activityClock:Report['activityClock'];
 daily:TimelineState;
 insights?:InsightState;
}
const money=(target:Record<string,string>,input:Record<string,string>)=>{for(const [currency,n] of Object.entries(input))target[currency]=(BigInt(target[currency]??'0')+BigInt(n)).toString();};
const categoryFields=['minutes','messages','observedMinutes','observedKnownMinutes','estimatedChatMinutes','viewerTotal','viewerKnownMinutes','viewerPartialMinutes','sessions','donationCount'] as const;
const hourFields=['knownViewersTotal','knownViewerSamples','viewerPartialMinutes','observed','estimated','messages','sampleMinutes','observedKnownMinutes','viewersTotal','viewerSamples','donationCount'] as const;
/** Prepare expensive minute/interval inputs once. Parents consume only sufficient statistics. */
export function streamFold(report:Report&{clockBuckets?:TimeAudienceSummary[]},timezone:string,insights?:InsightState):HistoryFold {
 const people=report.audience.map(p=>({...p,donations:{...p.donations},arrivalHours:p.arrivalHours.map(a=>({...a})),sessionCount:p.sessionIds.length,attendanceCount:p.attendanceSessionIds.length,
  observedMinutes:p.intervals.filter(i=>i.kind==='observed').reduce((n,i)=>n+(i.to-i.from)/60000,0),
  estimatedChatMinutes:p.intervals.filter(i=>i.kind!=='observed').reduce((n,i)=>n+(i.to-i.from)/60000,0),
  activityMinutes:unionSpans(p.intervals.map(i=>({...i,kind:'observed' as const}))).reduce((n,i)=>n+(i.to-i.from)/60000,0),
  sessionIds:p.sessionIds.slice(-100),attendanceSessionIds:p.attendanceSessionIds.slice(-100),intervals:p.intervals.slice(-100),messageMinutes:p.messageMinutes.slice(-100),messageCounts:[]}));
 const daily=new HistoryTimeline(timezone,new Map());daily.add(report);
 const categoryPeople:[string,string[]][]=report.categories.map(c=>[c.id,report.audience.filter(p=>p.intervals.some(i=>report.activityWindows.some(w=>w.categoryId===c.id&&w.session===i.session&&w.from<i.to&&w.to>i.from))||p.messageMinutes.some(m=>report.activityWindows.some(w=>w.categoryId===c.id&&w.session===m.session&&m.at>=w.from&&m.at<w.to))).map(p=>p.id)]);
 // Everything retained in sample is small presentation/coverage metadata. Minute,
 // membership and comparison arrays are represented by the explicit folded fields.
 const sample={...report,timeline:[],audience:[],activityWindows:[],activityClock:[],categories:[],hours:[],availableCategories:[],streamComparison:[],breaks:[],...( 'clockBuckets' in report?{clockBuckets:[]}:{}),...('insights' in report?{insights:[]}:{} )};
 return {sample,selectedStreams:Number(report.summary.streams>0),people,streams:report.streamComparison.map(row=>({row,visitors:report.audience.filter(p=>p.attendanceSessionIds.length).map(p=>p.id)})),categories:structuredClone(report.categories),categoryPeople,availableCategories:report.availableCategories,hours:structuredClone(report.hours),
  clock:(report.clockBuckets??[]).map(b=>({...b,people:[]})),activityClock:structuredClone(report.activityClock),daily:daily.snapshot(),...(insights?{insights}:{})};
}
/** Ordered monoid: sums are weighted numerators; identity sets are unions, never sums. */
export function mergeHistory(left:HistoryFold,right:HistoryFold,timezone:string):HistoryFold {
 const people=new Map(left.people.map(p=>[p.id,p]));
 for(const p of right.people){const row=people.get(p.id);if(!row){people.set(p.id,p);continue;}
  for(const field of ['messages','visits','observedMinutes','estimatedChatMinutes','activityMinutes','sessionCount','attendanceCount'] as const)row[field]+=p[field];
  row.sources=[...new Set([...row.sources,...p.sources])];row.accounts=[...new Map([...row.accounts,...p.accounts].map(a=>[a.source+':'+a.name,a])).values()];
  for(const field of ['sessionIds','attendanceSessionIds','intervals','messageMinutes'] as const)(row[field] as unknown[])=[...row[field],...p[field]].slice(-100);
  money(row.donations,p.donations);
  for(const arrival of p.arrivalHours){const prior=row.arrivalHours.find(a=>a.day===arrival.day&&a.hour===arrival.hour);if(prior)prior.visits+=arrival.visits;else row.arrivalHours.push(arrival);}
 }
 const categories=new Map(left.categories.map(c=>[c.id,c]));
 for(const c of right.categories){const row=categories.get(c.id);if(!row){categories.set(c.id,c);continue;}for(const field of categoryFields)row[field]+=c[field];money(row.donationTotals,c.donationTotals);}
 const members=new Map(left.categoryPeople.map(([id,people])=>[id,new Set(people)]));for(const [id,people] of right.categoryPeople){const ids=members.get(id)??new Set<string>();people.forEach(p=>ids.add(p));members.set(id,ids);}
 const hours=new Map(left.hours.map(c=>[`${c.day}:${c.hour}`,c]));for(const c of right.hours){const key=`${c.day}:${c.hour}`,row=hours.get(key);if(!row){hours.set(key,c);continue;}for(const field of hourFields)row[field]=(row[field]??0)+(c[field]??0);money(row.donationTotals,c.donationTotals);}
 const clock=new Map(left.clock.map(c=>[`${c.day}:${c.resolution}:${c.minute}`,c]));for(const c of right.clock){const key=`${c.day}:${c.resolution}:${c.minute}`,row=clock.get(key);if(!row){clock.set(key,c);continue;}row.streams+=c.streams;row.airtimeMs+=c.airtimeMs;row.personTimeMs+=c.personTimeMs;}
 const daily=new HistoryTimeline(timezone,new Map());daily.append(left.daily);daily.append(right.daily);
 let insights:InsightState|undefined;
 if(left.insights&&right.insights){const builder=new InsightAccumulator(new Map(),timezone);builder.append(left.insights);builder.append(right.insights);insights=builder.snapshot();}
 return {sample:right.sample,selectedStreams:left.selectedStreams+right.selectedStreams,people:[...people.values()],streams:[...left.streams,...right.streams],categories:[...categories.values()],categoryPeople:[...members].map(([id,people])=>[id,[...people]]),availableCategories:[...new Map([...left.availableCategories,...right.availableCategories].map(c=>[c.id,c])).values()],hours:[...hours.values()],clock:[...clock.values()],activityClock:mergeClockActivity(right.activityClock,new Map(left.activityClock.map(c=>[`${c.day}:${c.minute}`,c]))),daily:daily.snapshot(),...(insights?{insights}:{})};
}
