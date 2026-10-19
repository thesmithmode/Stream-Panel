import type Database from 'better-sqlite3';
import {assertTimestamp,type EventInput,eventKey} from './domain.js';

export const EVENT_RETENTION_MS=48*60*60*1000;
export const EVENT_CLEANUP_BATCH=500;
type RecentInput=Omit<EventInput,'source'|'sourceTime'|'timeQuality'|'transport'>&{source:EventInput['source']|'youtube'};
type RecentRow={id:string;source:string;account_id:string;external_id:string;type:string;actor_id:string|null;actor_name:string|null;at_ms:number;received_at_ms:number;payload_json:string};

/** Disposable content only. Permanent facts, deduplication and report revisions are independent. */
export class RecentEvents {
 constructor(private readonly db:Database.Database){}
 save(event:RecentInput,now=Date.now()):void {
  const at=event.occurredAtMs??event.receivedAtMs;
  // Old REST imports must never resurrect expired text.
  if(at<=now-EVENT_RETENTION_MS||at>now)return;
  const {raw:_raw,...payload}=event.payload;
  const id=JSON.stringify([event.source,event.accountId,event.type,event.externalId]);
  this.db.prepare('INSERT OR IGNORE INTO recent_events VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,event.source,event.accountId,event.externalId,event.type,event.actor?.externalId??null,event.actor?.displayName??null,at,event.receivedAtMs,JSON.stringify(payload));
 }
 saveEvent(event:EventInput):void {
  const redacted=event.source==='twitch'&&event.type==='chat.message'&&
   (this.db.prepare("SELECT json_extract(payload_json,'$.redacted') AS redacted FROM events WHERE id=?").get(eventKey(event)) as {redacted:number|null}|undefined)?.redacted;
  this.save(redacted?{...event,payload:{...event.payload,text:'',redacted:1}}:event);
 }
 redact(account:string,type:string,messageId:string,userId:string,from:number,to:number):void {
  const predicate=type==='chat.message_delete'?'external_id=?':type==='chat.clear_user_messages'?'actor_id=? AND at_ms>=? AND at_ms<=?':'at_ms>=? AND at_ms<=?';
  const args=type==='chat.message_delete'?[messageId]:type==='chat.clear_user_messages'?[userId,from,to]:[from,to];
  this.db.prepare(`UPDATE recent_events SET payload_json=json_set(payload_json,'$.text','','$.redacted',1) WHERE source='twitch' AND account_id=? AND type='chat.message' AND ${predicate}`).run(account,...args);
 }
 removeYoutube(account:string,messageId?:string,authorId?:string):void {
  if(messageId)this.db.prepare("DELETE FROM recent_events WHERE source='youtube' AND account_id=? AND external_id=?").run(account,messageId);
  if(authorId)this.db.prepare("DELETE FROM recent_events WHERE source='youtube' AND account_id=? AND actor_id=?").run(account,authorId);
 }
 list(offset=0,limit=100,now=Date.now()) {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error('INVALID_RECENT_EVENTS_PAGE');
  return (this.db.prepare('SELECT * FROM recent_events WHERE at_ms>? AND at_ms<=? ORDER BY at_ms DESC,id DESC LIMIT ? OFFSET ?').all(now-EVENT_RETENTION_MS,now,limit,offset) as RecentRow[]).map(({payload_json,...row})=>({...row,payload:JSON.parse(payload_json) as Record<string,unknown>}));
 }
 purge(now=Date.now()):number {
  assertTimestamp(now);
  return this.db.prepare('DELETE FROM recent_events WHERE id IN (SELECT id FROM recent_events WHERE at_ms<=? ORDER BY at_ms,id LIMIT ?)').run(now-EVENT_RETENTION_MS,EVENT_CLEANUP_BATCH).changes;
 }
}
