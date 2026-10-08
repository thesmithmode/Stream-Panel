import type {ChartMetric} from './chart-series';
export interface AnalyticsView {
 metric:ChartMetric; heatMetric:ChartMetric; sort:string; resolution:number; hourView:string;
 showRegulars:boolean; regularOnly:boolean; coreOnly:boolean;
 report:boolean; trend:boolean; categories:boolean; hours:boolean; streams:boolean; audience:boolean;
}
const options={metric:['observed','estimated','messages','viewers'],heatMetric:['observed','estimated','messages','viewers'],sort:['observedMinutes','estimatedChatMinutes','sessions','messages','attendanceRatio'],resolution:[0,1,5,15,60,1440],hourView:['both','map','table'],showRegulars:[true,false],regularOnly:[false,true],coreOnly:[false,true],report:[true,false],trend:[true,false],categories:[true,false],hours:[true,false],streams:[true,false],audience:[true,false]};
export function analyticsView(input:unknown):AnalyticsView {
 const saved=(input&&typeof input==='object'?input:{}) as Record<string,unknown>;
 return Object.fromEntries(Object.entries(options).map(([key,values])=>[key,(values as unknown[]).includes(saved[key])?saved[key]:values[0]])) as unknown as AnalyticsView;
}
