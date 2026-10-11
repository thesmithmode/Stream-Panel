import type {ChartMetric} from './chart-series';
export interface AnalyticsView {
 metric:ChartMetric; heatMetric:ChartMetric; sort:string; resolution:number; hourView:string;
 showRegulars:boolean; regularOnly:boolean; coreOnly:boolean;
 report:boolean; trend:boolean; categories:boolean; hours:boolean; streams:boolean; audience:boolean;
}
const options={metric:['viewers','participants','observed','estimated','messages','twitchViewers','youtubeViewers'],heatMetric:['observed','estimated','messages','viewers'],sort:['observedMinutes','estimatedChatMinutes','sessions','messages','attendanceRatio'],resolution:[0,1,5],hourView:['both','map','table'],showRegulars:[true,false],regularOnly:[false,true],coreOnly:[false,true],report:[true,false],trend:[true,false],categories:[true,false],hours:[true,false],streams:[true,false],audience:[true,false]};
export function analyticsView(input:unknown):AnalyticsView {
 const saved=(input&&typeof input==='object'?input:{}) as Record<string,unknown>;
 return Object.fromEntries(Object.entries(options).map(([key,values])=>[key,(values as unknown[]).includes(saved[key])?saved[key]:values[0]])) as unknown as AnalyticsView;
}
type PreferenceStorage={getItem(key:string):string|null;setItem(key:string,value:string):void};
/** Layout belongs to the application; audience filters belong to the selected profile. */
export function loadAnalyticsView(storage:()=>PreferenceStorage,profile:string):AnalyticsView {
 const read=(key:string)=>{try{return JSON.parse(storage().getItem(key)??'null');}catch{return null;}};
  const legacy=analyticsView(read(`sp-analytics-view-${profile}`));
  const shared=read('sp-analytics-view');
  const filters=read(`sp-analytics-filters-${profile}`);
  return analyticsView({...legacy,...shared,regularOnly:filters?.regularOnly??legacy.regularOnly,coreOnly:filters?.coreOnly??legacy.coreOnly});
}
export function saveAnalyticsView(storage:()=>PreferenceStorage,profile:string,view:AnalyticsView){
 const {regularOnly,coreOnly,...layout}=view;
 try{storage().setItem('sp-analytics-view',JSON.stringify(layout));storage().setItem(`sp-analytics-filters-${profile}`,JSON.stringify({regularOnly,coreOnly}));}catch{/* Browser persistence is optional. */}
}
