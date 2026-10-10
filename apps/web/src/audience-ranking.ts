export type RankMetric = 'observedMinutes' | 'messages' | 'estimatedChatMinutes';
export interface RankPerson {id:string;name:string;observedMinutes?:number;messages?:number;estimatedChatMinutes?:number;core?:boolean;intervals?:Array<{from:number;to:number;kind:string}>;}
export function audienceRanking(people:RankPerson[],metric:RankMetric) {
 return people.filter(person=>Number.isFinite(person[metric])&&(person[metric]??0)>0)
  .slice().sort((a,b)=>(b[metric]??0)-(a[metric]??0)||a.name.localeCompare(b.name,'ru')||a.id.localeCompare(b.id));
}
