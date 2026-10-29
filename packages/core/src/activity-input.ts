import type Database from 'better-sqlite3';
export type ActivityInput={person:string;session:string;source:'twitch'|'youtube';from:number;to:number};
/** Full-stream inputs, independent of report/category/timezone. Limits apply to
 * grouped intervals, never to the number of raw chat messages. */
export function readActivityInput(db:Database.Database,ids:string[],end:number,youtube:string|undefined,window:number,person=''):ActivityInput[]{
 const sessions=JSON.stringify(ids),out:ActivityInput[]=[];
 const rows=db.prepare(`WITH raw AS (SELECT p.session_id,i.person_id,cast(max(p.started_at_ms,s.started_at_ms)/60000 AS INTEGER) lo,cast(min(p.completed_at_ms,coalesce(s.ended_at_ms,?)-1)/60000 AS INTEGER) hi FROM presence_polls p JOIN presence_members m ON m.poll_id=p.id JOIN identities i ON i.id=m.identity_id JOIN sessions s ON s.id=p.session_id WHERE p.status='complete' AND (?='' OR i.person_id=?) AND p.session_id IN(SELECT value FROM json_each(?))), prior AS (SELECT *,max(hi) OVER(PARTITION BY session_id,person_id ORDER BY lo,hi ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous_hi FROM raw WHERE hi>=lo), tagged AS (SELECT *,sum(CASE WHEN previous_hi IS NULL OR lo>previous_hi+1 THEN 1 ELSE 0 END) OVER(PARTITION BY session_id,person_id ORDER BY lo,hi) cluster FROM prior) SELECT session_id,person_id,min(lo)*60000 first_ms,(max(hi)+1)*60000 last_ms FROM tagged GROUP BY session_id,person_id,cluster LIMIT 50001`).all(end,person,person,sessions) as {session_id:string;person_id:string;first_ms:number;last_ms:number}[];
 if(rows.length>50000)throw Error('ANALYTICS_RANGE_TOO_LARGE');
 for(const r of rows)out.push({person:r.person_id,session:r.session_id,source:'twitch',from:r.first_ms,to:r.last_ms});
 if(youtube&&ids.length){
  const rows=db.prepare(`WITH scoped AS (SELECT m.author_id,m.published_at_ms,(SELECT ps.session_id FROM platform_streams ps JOIN sessions s ON s.id=ps.session_id WHERE ps.platform='youtube' AND ps.account_id=m.account_id AND ps.started_at_ms<=m.published_at_ms AND coalesce(ps.ended_at_ms,s.ended_at_ms,?)>m.published_at_ms ORDER BY ps.started_at_ms DESC LIMIT 1) sid FROM youtube_messages m WHERE m.account_id=? AND m.author_id!=? AND m.author_id!='' AND m.published_at_ms>=(SELECT min(started_at_ms) FROM sessions WHERE id IN(SELECT value FROM json_each(?))) AND m.published_at_ms<? AND json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent')) SELECT y.person_id,scoped.sid,min(scoped.published_at_ms) first_ms,max(scoped.published_at_ms) last_ms FROM scoped JOIN youtube_identities y ON y.account_id=? AND y.external_id=scoped.author_id WHERE (?='' OR y.person_id=?) AND scoped.sid IN(SELECT value FROM json_each(?)) GROUP BY y.person_id,scoped.sid,cast(scoped.published_at_ms/60000 AS INTEGER) LIMIT 50001`).all(end,youtube,youtube,sessions,end,youtube,person,person,sessions) as {person_id:string;sid:string;first_ms:number;last_ms:number}[];
  if(rows.length>50000)throw Error('ANALYTICS_RANGE_TOO_LARGE');
  for(const r of rows)out.push({person:r.person_id,session:r.sid,source:'youtube',from:r.first_ms,to:r.last_ms+window*60000});
 }
 return out;
}
