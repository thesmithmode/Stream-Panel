import type {CountPoint,Publication} from '../../../packages/core/src/subscriber-history.ts';
export interface FollowPoint {id:string;name:string;at:number}
export function subscriberSteps(counts:CountPoint[],follows:FollowPoint[],source:string,from:number){
 const points:CountPoint[]=[];let cursor=0;
 for(let i=0;i<counts.length;i++){
  const current=counts[i]!,previous=counts[i-1];
  if(previous&&source==='twitch'){
   while(cursor<follows.length&&follows[cursor]!.at<=previous.at)cursor++;
   const start=cursor;while(cursor<follows.length&&follows[cursor]!.at<=current.at)cursor++;
   const events=follows.slice(start,cursor);
   // Only place count increases at provider times when they reconcile exactly.
   if(events.length&&current.total-previous.total===events.length)events.forEach((f,n)=>points.push({at:f.at,total:previous.total+n+1}));
  }
  points.push({...current,at:Math.max(from,current.at)});
 }
 return points;
}
export function stepPath(points:CountPoint[],x:(at:number)=>number,y:(value:number)=>number){
 return points.map((p,i)=>`${i?'H':'M'}${x(p.at)}${i?'V':','}${y(p.total)}`).join(' ');
}
export function publicationGroups(items:Publication[],from:number,to:number,width:number){
 const groups:{at:number;items:Publication[]}[]=[];
 for(const item of items){const previous=groups.at(-1);if(previous&&(item.publishedAt-previous.at)/(to-from)*width<30)previous.items.push(item);else groups.push({at:item.publishedAt,items:[item]});}
 return groups;
}
