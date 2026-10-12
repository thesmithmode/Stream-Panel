import type {ChartMetric} from './chart-series';
export interface AnalyticsView {
 metric:ChartMetric; heatMetric:ChartMetric|'donations'|'amount'; sort:string; resolution:number; hourView:string;
 showRegulars:boolean; regularOnly:boolean; coreOnly:boolean;
 report:boolean; trend:boolean; categories:boolean; hours:boolean; streams:boolean; audience:boolean;
}
const options={metric:['viewers','participants','observed','estimated','messages','twitchViewers','youtubeViewers'],heatMetric:['observed','estimated','messages','viewers','donations','amount'],sort:['sessions','observedMinutes','estimatedChatMinutes','messages','attendanceRatio'],resolution:[1,5,15],hourView:['both','map','table'],showRegulars:[true,false],regularOnly:[false,true],coreOnly:[false,true],report:[true,false],trend:[true,false],categories:[true,false],hours:[true,false],streams:[true,false],audience:[true,false]};
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
