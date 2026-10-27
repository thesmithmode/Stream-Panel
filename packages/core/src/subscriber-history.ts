import type Database from 'better-sqlite3';
import {assertTimestamp} from './domain.js';
export type SubscriberSource='twitch'|'youtube';
export interface Publication {id:string;title:string;publishedAt:number;kind:'shorts'|'video'|'unknown'}
export interface CountPoint {at:number;total:number}
export interface SubscriberQuery {source:SubscriberSource;account:string;from:number;to:number;streamsOnly?:boolean}
/** Channel totals are observations, never an inferred count of public subscribers. */
export class SubscriberHistory {
 constructor(private readonly db:Database.Database){}
 count(source:SubscriberSource,account:string,total:number,at:number){
  assertTimestamp(at);
  if(!['twitch','youtube'].includes(source)||!account||!Number.isSafeInteger(total)||total<0)throw new Error('INVALID_SUBSCRIBER_COUNT');
  this.db.prepare('INSERT INTO subscriber_counts VALUES (?,?,?,?) ON CONFLICT(source,account_id,observed_at_ms) DO UPDATE SET total=excluded.total').run(source,account,at,total);
 }
 follow(account:string,id:string,name:string,at:number){
  assertTimestamp(at);
  this.db.prepare('INSERT OR IGNORE INTO subscriber_follows VALUES (?,?,?,?,?)').run(account,id,at,name,Math.floor(at/1000));
 }
 publications(account:string,items:Publication[],at:number){
  assertTimestamp(at);
  if(!account||items.length>1000)throw new Error('INVALID_PUBLICATIONS');
  for(const item of items){assertTimestamp(item.publishedAt);if(!/^[A-Za-z0-9_-]{1,128}$/.test(item.id)||typeof item.title!=='string'||!['shorts','video','unknown'].includes(item.kind))throw new Error('INVALID_PUBLICATIONS');}
  this.db.transaction(()=>{
   const save=this.db.prepare(`INSERT INTO youtube_publications VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,video_id) DO UPDATE SET title=excluded.title,published_at_ms=excluded.published_at_ms,kind=CASE WHEN excluded.kind='unknown' THEN youtube_publications.kind ELSE excluded.kind END,updated_at_ms=excluded.updated_at_ms`);
   for(const item of items)save.run(account,item.id,item.title,item.publishedAt,item.kind,at);
  }).immediate();
 }
 streams({source,account,from,to}:SubscriberQuery){
  return this.db.prepare(`SELECT p.session_id AS id,p.started_at_ms AS start,min(coalesce(p.ended_at_ms,?),?) AS end,p.title FROM platform_streams p WHERE p.platform=? AND p.account_id=? AND p.started_at_ms<? AND coalesce(p.ended_at_ms,?)>? AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=p.session_id) ORDER BY p.started_at_ms`).all(to,to,source,account,to,to,from) as {id:string;start:number;end:number;title:string}[];
 }
 query(q:SubscriberQuery){
  const {source,account,from,to}=q;assertTimestamp(from);assertTimestamp(to);
  if(!['twitch','youtube'].includes(source)||to<=from||to-from>31*86400000||typeof account!=='string')throw new Error('INVALID_SUBSCRIBER_WINDOW');
  if(q.streamsOnly)return {source,from,to,counts:[] as CountPoint[],follows:[] as {id:string;name:string;at:number}[],streams:this.streams(q),publications:[] as Publication[],total:null,change:null,firstAt:null,lastAt:null};
  const prior=this.db.prepare('SELECT observed_at_ms AS at,total FROM subscriber_counts WHERE source=? AND account_id=? AND observed_at_ms<=? ORDER BY observed_at_ms DESC LIMIT 1').get(source,account,from) as CountPoint|undefined;
  // Keep both edges of constant runs, without sending 43,200 identical minute samples.
  const samples=this.db.prepare(`WITH values_in_window AS (SELECT observed_at_ms AS at,total,lag(total) OVER(ORDER BY observed_at_ms) AS previous,lead(total) OVER(ORDER BY observed_at_ms) AS next FROM subscriber_counts WHERE source=? AND account_id=? AND observed_at_ms>? AND observed_at_ms<=?) SELECT at,total FROM values_in_window WHERE previous IS NULL OR next IS NULL OR total IS NOT previous OR total IS NOT next ORDER BY at`).all(source,account,from,to) as CountPoint[];
  const counts=prior?[prior,...samples]:samples;
  const streams=this.streams(q);
  const publications=source==='youtube'?this.db.prepare('SELECT video_id AS id,title,published_at_ms AS publishedAt,kind FROM youtube_publications WHERE account_id=? AND published_at_ms>=? AND published_at_ms<? ORDER BY published_at_ms,video_id').all(account,from,to) as Publication[]:[];
  // A follower may be discovered after the window: use provider time, not poll time.
  const follows=source==='twitch'?this.db.prepare('SELECT external_id AS id,name,followed_at_ms AS at FROM subscriber_follows WHERE account_id=? AND followed_second>=? AND followed_second<=? AND followed_at_ms>=? AND followed_at_ms<? ORDER BY followed_at_ms,external_id').all(account,Math.floor(from/1000),Math.floor(to/1000),from,to) as {id:string;name:string;at:number}[]:[];
  const first=counts[0],last=counts.at(-1);
  return {source,from,to,counts,follows,streams,publications,total:last?.total??null,change:prior&&last?last.total-prior.total:null,firstAt:first?.at??null,lastAt:last?.at??null};
 }
}
