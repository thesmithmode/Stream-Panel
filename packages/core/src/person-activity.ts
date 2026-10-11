import type Database from 'better-sqlite3';
import {unionSpans} from './analytics.js';
export function personActivity(db:Database.Database,id:string){
 if(!db.prepare('SELECT 1 FROM persons WHERE id=?').get(id))throw new Error('PERSON_NOT_FOUND');
 const now=Date.now();
 const polls=db.prepare(`SELECT DISTINCT p.session_id AS session,p.started_at_ms AS start,p.completed_at_ms AS end,s.started_at_ms AS stream_start,coalesce(s.ended_at_ms,?) AS stream_end FROM presence_polls p JOIN presence_members m ON m.poll_id=p.id JOIN identities i ON i.id=m.identity_id JOIN sessions s ON s.id=p.session_id WHERE i.person_id=? AND p.status='complete' AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id) ORDER BY p.started_at_ms`).all(now,id) as {session:string;start:number;end:number;stream_start:number;stream_end:number}[];
 const spans=unionSpans(polls.map(p=>({session:p.session,kind:'observed' as const,from:Math.max(p.stream_start,Math.floor(p.start/60000)*60000),to:Math.min(p.stream_end,(Math.floor(p.end/60000)+1)*60000)})));
 const hours=Array.from({length:24},(_,hour)=>({hour,minutes:0}));const clock=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',hourCycle:'h23'});
 for(const span of spans)for(let at=span.from;at<span.to;){const next=Math.min(span.to,(Math.floor(at/3600000)+1)*3600000);hours[Number(clock.format(at))]!.minutes+=(next-at)/60000;at=next;}
 const visits=new Map<string,{session:string;at:number;minutes:number}>();
 for(const span of spans){const row=visits.get(span.session)??{session:span.session,at:span.from,minutes:0};row.at=Math.min(row.at,span.from);row.minutes+=(span.to-span.from)/60000;visits.set(span.session,row);}
 const redemptions=db.prepare("SELECT e.id,e.type,e.occurred_at_ms AS at,e.payload_json FROM effective_events e JOIN identities i ON i.id=e.identity_id WHERE i.person_id=? AND e.type LIKE 'channel_points%redemption%' ORDER BY e.occurred_at_ms DESC LIMIT 100").all(id) as {id:string;type:string;at:number|null;payload_json:string}[];
 // Updates of the same redemption do not add its cost twice.
 const rewards=new Map<string,{id:string;at:number|null;title:string;cost:number|null;status:string}>();
 for(const row of redemptions){const p=JSON.parse(row.payload_json),event=p.raw?.payload?.event??{};const key=event.id??row.id;if(rewards.has(key))continue;rewards.set(key,{id:key,at:row.at,title:p.reward?.title??event.reward?.title??'Награда',cost:typeof p.reward?.cost==='number'?p.reward.cost:null,status:event.status??'UNKNOWN'});}
 return {hours,visits:[...visits.values()].sort((a,b)=>a.at-b.at),rewards:[...rewards.values()],balance:null};
}
