import type {ChartPoint} from './chart-series';
export function missingTwitchPresence(points:readonly ChartPoint[]):boolean{
 return points.some(p=>(p.twitchMessages??0)>0)&&!points.some(p=>(p.observed??0)>0);
}
