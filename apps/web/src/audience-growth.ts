export type ViewerPlatform='all'|'twitch'|'youtube';
export interface GrowthStream {id?:string;startedAt:number;categories?:string[];viewers?:Partial<Record<ViewerPlatform,{mean?:number|null}>>}
/** Trailing time windows include only measured broadcasts; missing values never become zero. */
export function audienceGrowth(streams:GrowthStream[],platform:ViewerPlatform){
 const sorted=[...streams].sort((a,b)=>a.startedAt-b.startedAt||(a.id??'').localeCompare(b.id??''));
 const windows=[7,30].map(days=>({days,left:0,sum:0,count:0}));
 return sorted.map((stream,i)=>{
  const value=stream.viewers?.[platform]?.mean??null;
  const averages=windows.map(window=>{
   if(value!==null){window.sum+=value;window.count++;}
   while(window.left<=i&&sorted[window.left]!.startedAt<=stream.startedAt-window.days*86400000){
    const old=sorted[window.left++]!.viewers?.[platform]?.mean??null;
    if(old!==null){window.sum-=old;window.count--;}
   }
   return {value:window.count?window.sum/window.count:null,count:window.count};
  });
  return {...stream,value,trend:averages[0]!.value,trend30:averages[1]!.value,trendWindow:averages[0]!.count,trend30Window:averages[1]!.count};
 });
}
/** Cubic segments with horizontal end tangents stay inside adjacent values, without overshoot. */
export function growthPath(points:{x:number;y:number|null}[]){
 const known=points.filter((p):p is {x:number;y:number}=>p.y!==null);
 return known.map((p,i)=>{
  if(!i)return `M${p.x},${p.y}`;
  const previous=known[i-1]!,middle=(previous.x+p.x)/2;
  return `C${middle},${previous.y} ${middle},${p.y} ${p.x},${p.y}`;
 }).join(' ');
}
