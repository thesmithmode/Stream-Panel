import type {ChartMetric} from './chart-series';
import type {ClockViewMetric} from '../../../packages/core/src/clock-activity';
export type ActivityMetric=ClockViewMetric|'activeAudience';
export interface AnalyticsView {
 dailyMetric:'online'|'active';dailyPlatform:'all'|'twitch'|'youtube';categoryMetric:'meanOnline'|'observedPerKnownMinute'|'messagesPerHour';
 metric:ActivityMetric; heatMetric:ChartMetric|'donations'|'amount'; sort:string; resolution:number;
 showRegulars:boolean; regularOnly:boolean; coreOnly:boolean;
 report:boolean; trend:boolean; categories:boolean; hours:boolean; streams:boolean; audience:boolean;
}
const options={dailyMetric:['online','active'],dailyPlatform:['all','twitch','youtube'],categoryMetric:['meanOnline','observedPerKnownMinute','messagesPerHour'],metric:['viewers','messages','twitchViewers','youtubeViewers','twitchMessages','youtubeMessages','watchHours','twitchWatchHours','youtubeWatchHours','donations','activeAudience'],heatMetric:['observed','estimated','messages','viewers','donations','amount'],sort:['sessions','observedMinutes','estimatedChatMinutes','messages','attendanceRatio'],resolution:[15,1,5,30,60],showRegulars:[true,false],regularOnly:[false,true],coreOnly:[false,true],report:[true,false],trend:[true,false],categories:[true,false],hours:[true,false],streams:[true,false],audience:[true,false]};
export function analyticsView(input:unknown):AnalyticsView {
 const saved=(input&&typeof input==='object'?input:{}) as Record<string,unknown>;
 return Object.fromEntries(Object.entries(options).map(([key,values])=>[key,(values as unknown[]).includes(saved[key])?saved[key]:values[0]])) as unknown as AnalyticsView;
}
type PreferenceStorage={getItem(key:string):string|null;setItem(key:string,value:string):void};
/** Every display preference belongs to the selected profile. */
export function loadAnalyticsView(storage:()=>PreferenceStorage,profile:string):AnalyticsView {
 const read=(key:string)=>{try{return JSON.parse(storage().getItem(key)??'null');}catch{return null;}};
  const legacy=analyticsView(read(`sp-analytics-view-${profile}`));
  const filters=read(`sp-analytics-filters-${profile}`);
  return analyticsView({...legacy,regularOnly:filters?.regularOnly??legacy.regularOnly,coreOnly:filters?.coreOnly??legacy.coreOnly});
}
export function saveAnalyticsView(storage:()=>PreferenceStorage,profile:string,view:AnalyticsView){
 try{storage().setItem(`sp-analytics-view-${profile}`,JSON.stringify(view));storage().setItem(`sp-analytics-filters-${profile}`,JSON.stringify({regularOnly:view.regularOnly,coreOnly:view.coreOnly}));}catch{/* Browser persistence is optional. */}
}
