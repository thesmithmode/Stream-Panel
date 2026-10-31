import type Database from 'better-sqlite3';
import {AudienceQueries} from './audience-queries.js';
import {unionSpans} from './analytics.js';

export interface CurrentChatter {
 key:string; personId:string; name:string; source:'twitch'|'youtube';
 minutes:number|null; messages:number; lastMessageAt:number|null;
}
export interface CurrentChat {
 live:boolean; twitchState:'inactive'|'waiting'|'current'|'stale';
 observedAt:number|null; lastAttemptAt:number|null; youtubeWindowMinutes:number;
 people:CurrentChatter[];
}
type Link={platform:string;account_id:string;started_at_ms:number;ended_at_ms:number|null};
type Poll={id:string;status:string;completed_at_ms:number};

/** A small read model over existing collection facts, never a second provider client. */
export class CurrentChatQueries {
 private cache=new Map<string,CurrentChat>();
 constructor(private readonly db:Database.Database,private readonly audience:AudienceQueries){}
 read(sessionId:string,excluded:readonly string[],includeExcluded:boolean,now:number,revision:number):CurrentChat {
  const key=JSON.stringify([sessionId,excluded,includeExcluded,Math.floor(now/60000),revision]);
  const cached=this.cache.get(key);if(cached)return cached;
  const session=this.db.prepare('SELECT started_at_ms,ended_at_ms FROM sessions WHERE id=? AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=sessions.id)').get(sessionId) as {started_at_ms:number;ended_at_ms:number|null}|undefined;
  const empty:CurrentChat={live:false,twitchState:'inactive',observedAt:null,lastAttemptAt:null,youtubeWindowMinutes:10,people:[]};
  if(!session||session.ended_at_ms!==null)return empty;
  const links=this.db.prepare('SELECT platform,account_id,started_at_ms,ended_at_ms FROM platform_streams WHERE session_id=? ORDER BY started_at_ms').all(sessionId) as Link[];
  const active=links.filter(l=>l.ended_at_ms===null&&l.started_at_ms<=now);
  const result:CurrentChat={...empty,live:active.length>0,people:[]};
  const bots=this.audience.botJson(excluded),filter=includeExcluded?'1=1':this.audience.notBotClause('i');
  const twitch=active.filter(l=>l.platform==='twitch').at(-1);
  if(twitch){
   const args=[sessionId,twitch.account_id,twitch.started_at_ms,now];
   const where='session_id=? AND account_id=? AND completed_at_ms>=? AND completed_at_ms<=?';
   const attempt=this.db.prepare(`SELECT id,status,completed_at_ms FROM presence_polls p WHERE ${where} ORDER BY completed_at_ms DESC,(SELECT key FROM presence_poll_keys k WHERE k.poll_id=p.id) DESC LIMIT 1`).get(...args) as Poll|undefined;
   const poll=this.db.prepare(`SELECT id,status,completed_at_ms FROM presence_polls p WHERE ${where} AND status=\'complete\' ORDER BY completed_at_ms DESC,(SELECT key FROM presence_poll_keys k WHERE k.poll_id=p.id) DESC LIMIT 1`).get(...args) as Poll|undefined;
   result.observedAt=poll?.completed_at_ms??null;result.lastAttemptAt=attempt?.completed_at_ms??null;
   result.twitchState=!attempt?'waiting':!poll||attempt.status!=='complete'||now-poll.completed_at_ms>180000?'stale':'current';
   if(poll){
    const members=this.db.prepare(`SELECT i.id,i.external_id,i.person_id,i.display_name FROM presence_members m JOIN identities i ON i.id=m.identity_id WHERE m.poll_id=? AND i.source='twitch' AND i.account_id=? AND ${filter}`).all(poll.id,twitch.account_id,...(includeExcluded?[]:[bots])) as {id:string;external_id:string;person_id:string;display_name:string}[];
    const ids=JSON.stringify(members.map(m=>m.id));
    const counts=this.db.prepare(`SELECT i.external_id,count(*) messages,max(e.occurred_at_ms) lastMessageAt FROM event_sessions es JOIN effective_events e ON e.id=es.event_id JOIN identities i ON i.id=e.identity_id WHERE es.session_id=? AND i.id IN(SELECT value FROM json_each(?)) AND e.type='chat.message' AND e.occurred_at_ms<=? AND (json_extract(e.payload_json,'$.originChannelId') IS NULL OR json_extract(e.payload_json,'$.originChannelId')=e.account_id) GROUP BY i.external_id`).all(sessionId,ids,now) as {external_id:string;messages:number;lastMessageAt:number}[];
    // The historical ranking uses inclusive observed minute buckets. Union them so
    // overlapping polls/reconnections do not inflate current-stream duration.
    const spans=this.db.prepare(`SELECT i.external_id,p.started_at_ms,p.completed_at_ms FROM presence_polls p JOIN presence_members m ON m.poll_id=p.id JOIN identities i ON i.id=m.identity_id WHERE p.session_id=? AND p.status='complete' AND i.id IN(SELECT value FROM json_each(?)) AND p.completed_at_ms<=?`).all(sessionId,ids,now) as {external_id:string;started_at_ms:number;completed_at_ms:number}[];
    const byUser=new Map<string,Array<{session:string;kind:'observed';from:number;to:number}>>();
    for(const span of spans){const list=byUser.get(span.external_id)??[];list.push({session:sessionId,kind:'observed',from:Math.max(Math.floor(session.started_at_ms/60000)*60000,Math.floor(span.started_at_ms/60000)*60000),to:Math.min(Math.ceil(now/60000)*60000,(Math.floor(span.completed_at_ms/60000)+1)*60000)});byUser.set(span.external_id,list);}
    const stats=new Map(counts.map(c=>[c.external_id,c]));
    for(const member of members){const count=stats.get(member.external_id);const minutes=unionSpans(byUser.get(member.external_id)??[]).reduce((n,s)=>n+(s.to-s.from)/60000,0);result.people.push({key:`twitch:${twitch.account_id}:${member.external_id}`,personId:member.person_id,name:member.display_name,source:'twitch',minutes,messages:count?.messages??0,lastMessageAt:count?.lastMessageAt??null});}
   }
  }
  // YouTube supplies message authors, not join/leave observations. Admit only
  // recent authors from a still-active YouTube broadcast; never invent duration.
  for(const account of new Set(active.filter(l=>l.platform==='youtube').map(l=>l.account_id))){
   const rows=this.db.prepare(`SELECT y.external_id,y.person_id,y.display_name,count(*) messages,max(m.published_at_ms) lastMessageAt FROM youtube_messages m JOIN youtube_identities y ON y.account_id=m.account_id AND y.external_id=m.author_id WHERE m.account_id=? AND m.published_at_ms<=? AND json_extract(m.payload_json,'$.snippet.type') IN('textMessageEvent','superChatEvent','superStickerEvent') AND EXISTS(SELECT 1 FROM platform_streams p WHERE p.session_id=? AND p.platform='youtube' AND p.account_id=m.account_id AND m.published_at_ms>=p.started_at_ms AND (p.ended_at_ms IS NULL OR m.published_at_ms<p.ended_at_ms)) AND (?=1 OR (y.is_owner=0 AND y.external_id<>y.account_id AND y.match_key NOT IN(SELECT value FROM json_each(?)))) GROUP BY y.external_id HAVING max(m.published_at_ms)>?`).all(account,now,sessionId,Number(includeExcluded),bots,now-600000) as {external_id:string;person_id:string;display_name:string;messages:number;lastMessageAt:number}[];
   for(const row of rows)result.people.push({key:`youtube:${account}:${row.external_id}`,personId:row.person_id,name:row.display_name,source:'youtube',minutes:null,messages:row.messages,lastMessageAt:row.lastMessageAt});
  }
  if(this.cache.size>=8)this.cache.clear();this.cache.set(key,result);return result;
 }
}
