export type ChartMetric = 'observed' | 'estimated' | 'messages' | 'viewers' | 'twitchViewers' | 'youtubeViewers';
export interface ChartPoint {
  at: number;
  observed?: number;
  estimated?: number;
  messages?: number;
  viewers?: number | null;
  twitchViewers?:number|null;
  youtubeViewers?:number|null;
  presenceKnown?: boolean;
  isBreak?: boolean;
  regularObserved?: number;
  regularEstimated?: number;
  regularMessages?: number;
}
export function chartSeries(points: ChartPoint[], metric: ChartMetric, resolutionMinutes = 0) {
  if (!points.length) return [];
  const requested = Number.isFinite(resolutionMinutes) && resolutionMinutes > 0 ? resolutionMinutes : 0;
  const width = Math.max(60000, requested * 60000, Math.ceil((points.at(-1)!.at - points[0]!.at + 60000) / (requested ? 600 : 240) / 60000) * 60000);
  const regularKey = {observed: 'regularObserved', estimated: 'regularEstimated', messages: 'regularMessages', viewers:null,twitchViewers:null,youtubeViewers:null}[metric] as keyof ChartPoint | null;
  const map = new Map<number, {at: number; total: number; regular: number; n: number;breakMinutes:number;points:number}>();
  for (const point of points) {
    const at = Math.floor(point.at / width) * width;
    let bucket = map.get(at);
    if (!bucket) { bucket = {at, total: 0, regular: 0, n: 0,breakMinutes:0,points:0}; map.set(at, bucket); }
    bucket.points++;if(point.isBreak)bucket.breakMinutes++;
    const known = !point.isBreak&&(metric === 'observed' ? point.presenceKnown : ['viewers','twitchViewers','youtubeViewers'].includes(metric) ? point[metric] != null : true);
    if (known) {
      bucket.total += Number(point[metric] ?? 0);
      bucket.regular += regularKey ? Number(point[regularKey] ?? 0) : 0;
      bucket.n++;
    }
  }
  return [...map.values()].sort((a, b) => a.at - b.at).map(bucket => {
    const value = metric === 'messages' ? bucket.total : bucket.n ? bucket.total / bucket.n : 0;
    const regular = metric === 'messages' ? bucket.regular : bucket.n ? bucket.regular / bucket.n : 0;
    return {at: bucket.at, known: bucket.n > 0, isBreak:bucket.breakMinutes===bucket.points, value, regularValue: Math.max(0, Math.min(value, regular)), width};
  });
}
