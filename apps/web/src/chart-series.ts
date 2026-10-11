export type ChartMetric = 'participants' | 'observed' | 'estimated' | 'messages' | 'viewers' | 'twitchViewers' | 'youtubeViewers';
export interface ChartPoint {
  at: number;
  participants?:number;regularParticipants?:number;followerParticipants?:number;followerObserved?:number;followerEstimated?:number;followerMessages?:number;
  observed?: number;
  estimated?: number;
  messages?: number;
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
  const width = ([1,5,15].includes(resolutionMinutes)?resolutionMinutes:1)*60000;
  const regularKey = {participants:'regularParticipants',observed: 'regularObserved', estimated: 'regularEstimated', messages: 'regularMessages', viewers:null,twitchViewers:null,youtubeViewers:null}[metric] as keyof ChartPoint | null;
  const map = new Map<number, {at: number; total: number; regular: number; follower:number; n: number;breakMinutes:number;points:number;partial:boolean;twitch:number;twitchN:number;youtube:number;youtubeN:number}>();
  for (const point of points) {
    const at = Math.floor(point.at / width) * width;
    let bucket = map.get(at);
    if (!bucket) { bucket = {at, total: 0, regular: 0, follower:0, n: 0,breakMinutes:0,points:0,partial:false,twitch:0,twitchN:0,youtube:0,youtubeN:0}; map.set(at, bucket); }
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
      const followerKey={participants:'followerParticipants',observed:'followerObserved',estimated:'followerEstimated',messages:'followerMessages',viewers:null,twitchViewers:null,youtubeViewers:null}[metric] as keyof ChartPoint|null;
      bucket.follower+=followerKey?Number(point[followerKey]??0):0;
      bucket.n++;
    }
  }
  return [...map.values()].sort((a, b) => a.at - b.at).map(bucket => {
    const value = metric === 'viewers' && (bucket.twitchN||bucket.youtubeN) ? (bucket.twitchN?bucket.twitch/bucket.twitchN:0)+(bucket.youtubeN?bucket.youtube/bucket.youtubeN:0) : metric === 'messages' ? bucket.total : bucket.n ? bucket.total / bucket.n : 0;
    const regular = metric === 'messages' ? bucket.regular : bucket.n ? bucket.regular / bucket.n : 0;
    const follower=metric==='messages'?bucket.follower:bucket.n?bucket.follower/bucket.n:0;
    return {...(bucket.partial?{partial:true}:{}),followerValue:Math.max(0,Math.min(value-regular,follower)),at: bucket.at, known: bucket.n > 0, isBreak:bucket.breakMinutes===bucket.points, value, regularValue: Math.max(0, Math.min(value, regular)), width};
  });
}
