export type ViewerPlatform='all'|'twitch'|'youtube';
export interface GrowthStream {id:string;startedAt:number;categories?:string[];viewers?:Partial<Record<ViewerPlatform,{mean?:number|null}>>}
/** Seven consecutive chronological streams, including this stream. Unknown means stay unknown. */
export function audienceGrowth(streams:GrowthStream[],platform:ViewerPlatform){
 const sorted=[...streams].sort((a,b)=>a.startedAt-b.startedAt||a.id.localeCompare(b.id));
 return sorted.map((stream,i)=>{
  const value=stream.viewers?.[platform]?.mean??null,window=sorted.slice(Math.max(0,i-6),i+1).map(s=>s.viewers?.[platform]?.mean??null);
  return {...stream,value,trend:window.length===7&&window.every(v=>v!==null)?window.reduce<number>((sum,n)=>sum+n!,0)/7:null};
 });
}
