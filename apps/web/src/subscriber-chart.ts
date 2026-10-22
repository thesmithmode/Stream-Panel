import type {CountPoint} from '../../../packages/core/src/subscriber-history.ts';
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
/** Last known value at a time; never invent history before the first observation. */
export function subscriberValueAt(points:CountPoint[],at:number):number|null{
 let low=0,high=points.length;
 while(low<high){const middle=(low+high)>>>1;if(points[middle]!.at<=at)low=middle+1;else high=middle;}
 return low?points[low-1]!.total:null;
}
/** Extend the last known count to the requested time, without adding observations. */
export function subscriberPath(points:CountPoint[],to:number,x:(at:number)=>number,y:(value:number)=>number){
 const last=points.at(-1);
 return stepPath(points,x,y)+(last&&to>last.at?` H${x(to)}`:'');
}
