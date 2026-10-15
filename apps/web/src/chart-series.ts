export type ChartMetric = 'participants' | 'observed' | 'estimated' | 'messages' | 'viewers' | 'twitchViewers' | 'youtubeViewers' | 'twitchMessages' | 'youtubeMessages';
export interface ChartPoint {
  at: number;
  participants?:number;regularParticipants?:number;followerParticipants?:number;followerObserved?:number;followerEstimated?:number;followerMessages?:number;
  observed?: number;
  estimated?: number;
  messages?: number;
  twitchMessages?:number;youtubeMessages?:number;regularTwitchMessages?:number;regularYoutubeMessages?:number;followerTwitchMessages?:number;followerYoutubeMessages?:number;unknownMessages?:number;unknownTwitchMessages?:number;unknownYoutubeMessages?:number;
  viewers?: number | null;
  viewersPartial?: boolean;
  twitchViewers?:number|null;
  youtubeViewers?:number|null;
  presenceKnown?: boolean;
  isBreak?: boolean;
  regularObserved?: number;
  regularEstimated?: number;
  regularMessages?: number;
}
export function chartSeries(points: ChartPoint[], metric: ChartMetric, resolutionMinutes = 1) {
  if (!points.length) return [];
  const width = ([1,5,15,1440].includes(resolutionMinutes)?resolutionMinutes:1)*60000;
  const regularKey = {participants:'regularParticipants',observed: 'regularObserved', estimated: 'regularEstimated', messages: 'regularMessages',twitchMessages:'regularTwitchMessages',youtubeMessages:'regularYoutubeMessages', viewers:null,twitchViewers:null,youtubeViewers:null}[metric] as keyof ChartPoint | null;
  const map = new Map<number, {at: number; total: number; regular: number; follower:number; unknown:number; n: number;breakMinutes:number;points:number;partial:boolean;twitch:number;twitchN:number;youtube:number;youtubeN:number}>();
  for (const point of points) {
    const at = resolutionMinutes===1440?point.at:Math.floor(point.at / width) * width;
    let bucket = map.get(at);
    if (!bucket) { bucket = {at, total: 0, regular: 0, follower:0, unknown:0, n: 0,breakMinutes:0,points:0,partial:false,twitch:0,twitchN:0,youtube:0,youtubeN:0}; map.set(at, bucket); }
    if(!point.isBreak&&metric==='viewers'&&point.viewers!=null){
      if(point.twitchViewers!=null){bucket.twitch+=point.twitchViewers;bucket.twitchN++;}
      if(point.youtubeViewers!=null){bucket.youtube+=point.youtubeViewers;bucket.youtubeN++;}
      if(point.viewersPartial)bucket.partial=true;
    }
    bucket.points++;if(point.isBreak)bucket.breakMinutes++;
    const known = !point.isBreak&&(metric === 'observed' ? point.presenceKnown : ['viewers','twitchViewers','youtubeViewers'].includes(metric) ? point[metric] != null : true);
    if (known) {
      bucket.total += Number(point[metric] ?? 0);
      bucket.regular += regularKey ? Number(point[regularKey] ?? 0) : 0;
      const followerKey={participants:'followerParticipants',observed:'followerObserved',estimated:'followerEstimated',messages:'followerMessages',twitchMessages:'followerTwitchMessages',youtubeMessages:'followerYoutubeMessages',viewers:null,twitchViewers:null,youtubeViewers:null}[metric] as keyof ChartPoint|null;
      bucket.follower+=followerKey?Number(point[followerKey]??0):0;
      const unknownKey={messages:'unknownMessages',twitchMessages:'unknownTwitchMessages',youtubeMessages:'unknownYoutubeMessages'}[metric as 'messages'|'twitchMessages'|'youtubeMessages'] as keyof ChartPoint|undefined;
      bucket.unknown+=unknownKey?Number(point[unknownKey]??0):0;
      bucket.n++;
    }
  }
  return [...map.values()].sort((a, b) => a.at - b.at).map(bucket => {
    const value = metric === 'viewers' && (bucket.twitchN||bucket.youtubeN) ? (bucket.twitchN?bucket.twitch/bucket.twitchN:0)+(bucket.youtubeN?bucket.youtube/bucket.youtubeN:0) : isMessageMetric(metric) ? bucket.total : bucket.n ? bucket.total / bucket.n : 0;
    const regular = isMessageMetric(metric) ? bucket.regular : bucket.n ? bucket.regular / bucket.n : 0;
    const follower=isMessageMetric(metric)?bucket.follower:bucket.n?bucket.follower/bucket.n:0;
    const regularValue=Math.max(0,Math.min(value,regular)),followerValue=Math.max(0,Math.min(value-regularValue,follower));
    return {...(isMessageMetric(metric)?{unknownValue:Math.max(0,Math.min(value-regularValue-followerValue,bucket.unknown))}:{}),...(bucket.partial?{partial:true}:{}),followerValue,at: bucket.at, known: bucket.n > 0, isBreak:bucket.breakMinutes===bucket.points, value, regularValue, width};
  });
}

export const chartMetrics: {value:ChartMetric;label:string}[]=[
  {value:'viewers',label:'Зрители (все)'},{value:'twitchViewers',label:'Зрители Twitch'},{value:'youtubeViewers',label:'Зрители YouTube'},
  {value:'messages',label:'Сообщения (все)'},{value:'twitchMessages',label:'Сообщения Twitch'},{value:'youtubeMessages',label:'Сообщения YouTube'},
];
export const isMessageMetric=(metric:ChartMetric)=>['messages','twitchMessages','youtubeMessages'].includes(metric);
export const metricSource=(metric:ChartMetric)=>metric.startsWith('twitch')?'twitch':metric.startsWith('youtube')?'youtube':'all';
