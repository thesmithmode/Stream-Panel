import {botExclusionSet} from './bots.js';
import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {statfsSync} from 'node:fs';
import {dirname} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {audienceAnalytics,unionSpans,type AnalyticsOptions} from './analytics.js';
import {timePatterns} from './time-patterns.js';
import {latestFollowerSnapshotsSql} from './follower-queries.js';
type Report=ReturnType<typeof audienceAnalytics>;
/** Durable fact projections are independent of expendable rendered responses. */
export class StreamFacts {
 private readonly db:Database.Database;
 private staged:(()=>void)[]|undefined;
 private snapshots=new WeakMap<Report,{activity:number;key:string;complete:boolean}>();
 constructor(db:Database.Database,private readonly policy:{availableBytes?:()=>number;maxTotalBytes?:number}={}){
  const statements=new Map<string,Database.Statement>();
  this.db=new Proxy(db,{get(target,property){
   if(property==='prepare')return(sql:string)=>{let statement=statements.get(sql);if(statement&&!statement.busy)return statement;statement=target.prepare(sql);if(statements.size<256)statements.set(sql,statement);return statement;};
   const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
 }
 versions(id:string){return this.db.prepare('SELECT coalesce(sum(activity),0) activity,coalesce(sum(money),0) money FROM analytics_fact_versions WHERE session_id=? OR session_id IN(SELECT member_id FROM session_groups WHERE group_id=?)').get(id,id) as {activity:number;money:number};}
 read(options:AnalyticsOptions,id:string,start:number,end:number|null):Report{
  // WAL readers see one factual snapshot while the collection connection keeps writing.
  // Publish projections only after releasing that read transaction (no read-to-write upgrade).
  const writes:(()=>void)[]=[];this.staged=writes;let report:Report;
  try{report=this.db.transaction(()=>{
   const {q,key,complete}=this.scope(options,id,start,end),{activity,money}=this.versions(id);
   const base=this.load('analytics_stream_facts',id,key,activity,()=>audienceAnalytics(this.db,{...q,activityOnly:true}),complete);
   const moneyKey=createHash('sha256').update(JSON.stringify([key,base.activityWindows])).digest('hex');
   const finance=this.load('analytics_money_facts',id,moneyKey,money,()=>audienceAnalytics(this.db,{...q,donationsOnly:true}),complete);
   const value=combine(base,finance);this.snapshots.set(value,{activity,key,complete});return value;
  })();}finally{this.staged=undefined;}
  for(const write of writes)write();return report;
 }
 /** Activity-only consumers (records) never load or invalidate financial projections. */
 activity(options:AnalyticsOptions,id:string,start:number,end:number|null):Report{
  const writes:(()=>void)[]=[];this.staged=writes;let report:Report;
  try{report=this.db.transaction(()=>{const {q,key,complete}=this.scope(options,id,start,end);
   return this.load('analytics_stream_facts',id,key,this.versions(id).activity,()=>audienceAnalytics(this.db,{...q,activityOnly:true}),complete);
  })();}finally{this.staged=undefined;}
  for(const write of writes)write();return report;
 }
 private scope(options:AnalyticsOptions,id:string,start:number,end:number|null){
  const q={...options,sessionId:id,fromMs:Math.max(options.fromMs,start),toMs:Math.min(options.toMs,end??options.toMs)};
  const members=this.db.prepare('SELECT member_id FROM session_groups WHERE group_id=? ORDER BY member_id').all(id);
  const fields={format:4,members,from:q.fromMs,to:end===null&&q.toMs>=Date.now()-120000?'live':q.toMs,source:q.source??'all',category:q.category??'',timezone:q.timezone??'Europe/Moscow',chatWindowMinutes:q.chatWindowMinutes??5,excluded:[...botExclusionSet(q.excludedLogins??[])].sort(),owner:q.ownerId??'',youtube:q.youtubeAccount??'',minSessions:q.minSessions??3,minMinutes:q.minMinutes??30,minMessages:q.minMessages??5,regularThresholdPercent:q.regularThresholdPercent??80,coreRule:q.coreRule??'either'};
  return {q,key:createHash('sha256').update(JSON.stringify(fields)).digest('hex'),complete:end!==null&&q.fromMs===start&&q.toMs===end};

 }
 details<T>(options:AnalyticsOptions,id:string,start:number,end:number|null,build:()=>T,report?:Report):T{
  const captured=report?this.snapshots.get(report):undefined;
  const {key,complete}=captured??this.scope(options,id,start,end),revision=captured?.activity??this.versions(id).activity;
  const row=this.db.prepare('SELECT payload FROM analytics_activity_details WHERE session_id=? AND settings_key=? AND revision=?').get(id,key,revision) as {payload:Buffer}|undefined;
  if(row){try{return JSON.parse(gunzipSync(row.payload,{maxOutputLength:16*1024*1024}).toString()) as T;}catch{this.db.prepare('DELETE FROM analytics_activity_details WHERE session_id=? AND settings_key=?').run(id,key);}}
  const value=build();this.save('analytics_activity_details',id,key,revision,value,complete);return value;
 }
 private load(table:'analytics_stream_facts'|'analytics_money_facts',id:string,key:string,revision:number,build:()=>Report,complete:boolean):Report{
  const row=this.db.prepare(`SELECT payload FROM ${table} WHERE session_id=? AND settings_key=? AND revision=?`).get(id,key,revision) as {payload:Buffer}|undefined;
  if(row){try{return JSON.parse(gunzipSync(row.payload,{maxOutputLength:16*1024*1024}).toString()) as Report;}catch{/* Rebuild after the read snapshot; publishing replaces the damaged projection. */}}
  const value=build();this.save(table,id,key,revision,value,complete);
  return value;
 }
 private save(table:'analytics_stream_facts'|'analytics_money_facts'|'analytics_activity_details',id:string,key:string,revision:number,value:unknown,complete:boolean){
  if(this.staged){this.staged.push(()=>this.save(table,id,key,revision,value,complete));return;}
  const json=JSON.stringify(value);if(Buffer.byteLength(json)>16*1024*1024||(this.policy.maxTotalBytes??Infinity)<=0)return;
  const available=this.policy.availableBytes?.()??(this.db.name===':memory:'?Infinity:(()=>{const fs=statfsSync(dirname(this.db.name));return fs.bavail*fs.bsize;})());
  if(available<1024*1024*1024)return;
  this.db.transaction(()=>{
   this.db.prepare(`INSERT INTO ${table}(session_id,settings_key,revision,payload,complete,updated_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,settings_key) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,complete=excluded.complete,updated_at_ms=excluded.updated_at_ms`).run(id,key,revision,gzipSync(json),Number(complete),Date.now());
   // Keep immutable full-stream facts; bound transient clips of moving 7/30-day windows.
   this.db.prepare(`DELETE FROM ${table} WHERE session_id=? AND complete=0 AND settings_key<>? AND settings_key NOT IN(SELECT settings_key FROM ${table} WHERE session_id=? AND complete=0 AND settings_key<>? ORDER BY updated_at_ms DESC,settings_key LIMIT 3)`).run(id,key,id,key);
  })();
 }
 /** Apply current metadata without reading historical attendance. */
 present<T extends Report>(value:T,options?:AnalyticsOptions):T{
  const ids=JSON.stringify(value.audience.map(p=>p.id));
  const names=new Map((this.db.prepare('SELECT id,display_name FROM persons WHERE id IN(SELECT value FROM json_each(?))').all(ids) as {id:string;display_name:string}[]).map(p=>[p.id,p.display_name]));
  const preferences=new Map((this.db.prepare('SELECT person_id,manual_core FROM person_preferences WHERE person_id IN(SELECT value FROM json_each(?))').all(ids) as {person_id:string;manual_core:number|null}[]).map(p=>[p.person_id,p.manual_core]));
  const tags=this.db.prepare(`WITH RECURSIVE owners(person_id,origin_id) AS (SELECT value,value FROM json_each(?) UNION SELECT o.person_id,m.source_person_id FROM owners o JOIN person_merges m ON m.target_person_id=o.origin_id WHERE m.undone_at_ms IS NULL) SELECT DISTINCT o.person_id,t.label FROM owners o JOIN person_tags t ON t.person_id=o.origin_id ORDER BY t.label`).all(ids) as {person_id:string;label:string}[];
  const snapshots=this.db.prepare(latestFollowerSnapshotsSql).all() as {source:string;account_id:string;payload_json:string}[];
  const following=new Set<string>(),negative=new Set<string>(),platformFollowers:Record<string,Set<string>>={twitch:new Set(),youtube:new Set()},platformNegative:Record<string,Set<string>>={twitch:new Set(),youtube:new Set()};
  for(const snapshot of snapshots){const info=JSON.parse(snapshot.payload_json),followers=JSON.stringify((info.followers??[]).map((f:{id:string})=>f.id));
   const table=snapshot.source==='youtube'?'youtube_identities':'identities';
   for(const r of this.db.prepare(`SELECT DISTINCT person_id FROM ${table} WHERE account_id=? AND external_id IN(SELECT value FROM json_each(?))`).all(snapshot.account_id,followers) as {person_id:string}[]){following.add(r.person_id);platformFollowers[snapshot.source]?.add(r.person_id);}
   if(snapshot.source==='twitch'&&info.complete)for(const r of this.db.prepare("SELECT DISTINCT person_id FROM identities WHERE source='twitch' AND account_id=? AND external_id NOT IN(SELECT value FROM json_each(?))").all(snapshot.account_id,followers) as {person_id:string}[]){negative.add(r.person_id);platformNegative.twitch!.add(r.person_id);}
  }
  const audience=value.audience.map(p=>{const override=preferences.get(p.id),f=value.filters,long=unionSpans(p.intervals.map(s=>({...s,kind:'observed' as const}))).reduce((sum,s)=>sum+(s.to-s.from)/60000,0)>=f.minMinutes,chatty=p.messages>=f.minMessages;
   const automatic=p.coreSessionIds.length>=f.minSessions&&p.coreSessionIds.length>0&&p.coreSessionIds.length/value.summary.streams*100+1e-10>=f.regularThresholdPercent&&(f.coreRule==='frequency'||(f.coreRule==='both'?long&&chatty:long||chatty));
   const core=override==null?automatic:override===1;
   return {...p,name:names.get(p.id)??p.name,tags:tags.filter(t=>t.person_id===p.id).map(t=>t.label),manualCore:override==null?null:override===1,core,regular:core,follower:following.has(p.id)?true:negative.has(p.id)&&!p.sources.includes('youtube')?false:null};});
  const attendees=audience.filter(p=>p.attendanceSessionIds.length),core=audience.filter(p=>p.core).length;
  const composition={core:attendees.filter(p=>p.core).length,followers:attendees.filter(p=>!p.core&&p.follower===true).length,nonFollowers:attendees.filter(p=>!p.core&&p.follower===false).length,unknown:attendees.filter(p=>!p.core&&p.follower===null).length,twitch:attendees.filter(p=>p.sources.includes('twitch')).length,youtube:attendees.filter(p=>p.sources.includes('youtube')).length,both:attendees.filter(p=>p.sources.length>1).length};
  const timeline=value.timeline.map(p=>({...p,regularParticipants:0,followerParticipants:0,regularObserved:0,followerObserved:0,regularEstimated:0,followerEstimated:0,regularMessages:0,followerMessages:0,unknownMessages:0,regularTwitchMessages:0,followerTwitchMessages:0,unknownTwitchMessages:0,regularYoutubeMessages:0,followerYoutubeMessages:0,unknownYoutubeMessages:0})),minutes=new Map(timeline.map(p=>[p.at,p]));
  for(const person of audience){const seen=new Set<number>(),kinds=new Set<string>();for(const span of person.intervals)for(let at=Math.floor(span.from/60000)*60000;at<span.to;at+=60000){const point=minutes.get(at);if(!point)continue;
    if(!seen.has(at)){seen.add(at);if(person.core)point.regularParticipants++;else if(person.follower)point.followerParticipants++;}
    const signal=`${span.kind}:${at}`;if(kinds.has(signal))continue;kinds.add(signal);
    if(span.kind==='observed'){if(person.core)point.regularObserved++;else if(person.follower)point.followerObserved++;}else{if(person.core)point.regularEstimated++;else if(person.follower)point.followerEstimated++;}}
   for(const message of person.messageCounts){const point=minutes.get(message.at);if(!point)continue;const platform=message.source==='twitch'?'Twitch':'Youtube',group=person.core?'regular':platformFollowers[message.source]?.has(person.id)?'follower':!platformNegative[message.source]?.has(person.id)?'unknown':null;if(group){point[`${group}Messages`]+=message.count;point[`${group}${platform}Messages`]+=message.count;}}
  }
  const channel=options?.source!=='twitch'&&options?.youtubeAccount?this.db.prepare("SELECT payload_json,updated_at_ms FROM youtube_snapshots WHERE account_id=? AND key='report'").get(options.youtubeAccount) as {payload_json:string;updated_at_ms:number}|undefined:undefined;
  return {...value,...(options?{youtubeReport:channel?{data:JSON.parse(channel.payload_json),updatedAt:channel.updated_at_ms}:null}:{}),audience,composition,timeline,summary:{...value.summary,core,regulars:core,regularShare:audience.length?core/audience.length:null},categories:value.categories.map(c=>({...c,core:audience.filter(p=>p.core&&(p.intervals.some(s=>value.activityWindows.some(w=>w.categoryId===c.id&&w.session===s.session&&w.from<s.to&&w.to>s.from))||p.messageMinutes.some(m=>value.activityWindows.some(w=>w.categoryId===c.id&&w.session===m.session&&m.at>=w.from&&m.at<w.to)))).length})),streamComparison:value.streamComparison.map(s=>({...s,core:audience.filter(p=>p.core&&p.attendanceSessionIds.includes(s.id)).length}))};
 }
}
function combine(activity:Report,finance:Report):Report{
 const money=new Map(finance.audience.map(p=>[p.id,p]));
 const audience=activity.audience.map(p=>{const tip=money.get(p.id);money.delete(p.id);return {...p,donations:tip?.donations??{},sessionIds:[...new Set([...p.sessionIds,...tip?.sessionIds??[]])]};});
 audience.push(...money.values());
 const categories=activity.categories.map(c=>{const f=finance.categories.find(x=>x.id===c.id);return {...c,donationCount:f?.donationCount??0,donationTotals:f?.donationTotals??{},donationsPerHourMinor:f?.donationsPerHourMinor??{}};});
 const hours=activity.hours.map(h=>{const f=finance.hours.find(x=>x.day===h.day&&x.hour===h.hour);return {...h,donationCount:f?.donationCount??0,donationTotals:f?.donationTotals??{},donationsPerHourMinor:f?.donationsPerHourMinor??{}};});
 const activityClock=activity.activityClock.map(c=>{const f=finance.activityClock.find(x=>x.day===c.day&&x.minute===c.minute),totals=[...c.totals],durations=[...c.durations];totals[6]=f?.totals[6]??0;durations[6]=f?.durations[6]??durations[6]??0;return {...c,totals,durations,...(f?.donationAmounts?{donationAmounts:f.donationAmounts}:{})};});
 const streamComparison=activity.streamComparison.map(s=>{const f=finance.streamComparison.find(x=>x.id===s.id);return {...s,donationCount:f?.donationCount??0,donationTotals:f?.donationTotals??{},donationsPerHourMinor:f?.donationsPerHourMinor??{}};});
 return {...activity,audience,categories,hours,activityClock,streamComparison,patterns:timePatterns(hours),donationTiming:finance.donationTiming,summary:{...activity.summary,entities:audience.length}};
}
