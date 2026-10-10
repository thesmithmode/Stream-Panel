import type Database from 'better-sqlite3';
export interface TimeWindow {from:number;to:number}
/** Union of provider broadcasts. A platform interruption is not a break if another stays live. */
export function sessionWindows(db:Database.Database,id:string,from:number,to:number):TimeWindow[]{
 const links=db.prepare('SELECT started_at_ms,ended_at_ms FROM platform_streams WHERE session_id=? ORDER BY started_at_ms').all(id) as {started_at_ms:number;ended_at_ms:number|null}[];
 if(!links.length)return to>from?[{from,to}]:[];
 const out:TimeWindow[]=[];
 for(const link of links){
  const span={from:Math.max(from,link.started_at_ms),to:Math.min(to,link.ended_at_ms??to)};
  if(span.to<=span.from)continue;
  const last=out.at(-1);
  if(last&&span.from<=last.to)last.to=Math.max(last.to,span.to);else out.push(span);
 }
 return out;
}
export function sessionBreaks(windows:TimeWindow[]):TimeWindow[]{
 return windows.slice(1).map((span,i)=>({from:windows[i]!.to,to:span.from}));
}
