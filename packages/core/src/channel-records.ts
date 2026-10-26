import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {AnalyticsReportCache} from './analytics-report-cache.js';
type RecordValue={value:number;at:number};
export type ChannelRecordValues={online:RecordValue|null;messages:RecordValue|null;peakOnline:RecordValue|null;peakChat:RecordValue|null};
type Row={id:string;signature:string;at:number;online:number|null;messages:number;peakOnline:number|null;peakChat:number|null;peakOnlineAt:number;peakChatAt:number};
/** Compact derived facts. Reuse unchanged streams, including across process restarts. */
export class ChannelRecords {
 private scope='';
 private rows=new Map<string,Row>();
 private cache:AnalyticsReportCache<Row[]>;
 constructor(private db:Database.Database,private metric:(id:string,botJson:string)=>{viewerKnownMean?:unknown;messageCount?:unknown;viewerKnownPeak?:unknown;viewerPeakAt?:number;peakChat?:number|null;peakChatAt?:number}|undefined){this.cache=new AnalyticsReportCache(db);}
 read(botJson:string):ChannelRecordValues{
  const key=createHash('sha256').update('channel-records-v3:'+botJson).digest('hex');
  if(this.scope!==key){this.rows=new Map((this.cache.get(key)??[]).map(row=>[row.id,row]));this.scope=key;}
  const streams=this.db.prepare(`SELECT s.id,s.started_at_ms at,s.ended_at_ms ended,(SELECT sum(activity) FROM analytics_fact_versions v WHERE v.session_id=s.id OR v.session_id IN(SELECT member_id FROM session_groups WHERE group_id=s.id)) revision,
   (SELECT json_group_array(member_id) FROM session_groups WHERE group_id=s.id) members
   FROM sessions s
   WHERE NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id) ORDER BY s.started_at_ms,s.id`).all() as {id:string;at:number;ended:number|null;revision:number;members:string}[];
  const ids=new Set(streams.map(s=>s.id));let changed=false;
  for(const id of this.rows.keys())if(!ids.has(id)){this.rows.delete(id);changed=true;}
  let online:RecordValue|null=null,messages:RecordValue|null=null,peakOnline:RecordValue|null=null,peakChat:RecordValue|null=null;
  for(const stream of streams){
   const signature=JSON.stringify([stream.at,stream.ended,stream.revision,stream.members]);
   let row=this.rows.get(stream.id);
   if(row?.signature!==signature){
    const metrics=this.metric(stream.id,botJson);
    row={id:stream.id,signature,at:stream.at,online:typeof metrics?.viewerKnownMean==='number'?metrics.viewerKnownMean:null,messages:Number(metrics?.messageCount??0),peakOnline:typeof metrics?.viewerKnownPeak==='number'?metrics.viewerKnownPeak:null,peakChat:metrics?.peakChat??null,peakOnlineAt:metrics?.viewerPeakAt??stream.at,peakChatAt:metrics?.peakChatAt??stream.at};
    this.rows.set(stream.id,row);changed=true;
   }
   if(row.online!==null&&(!online||row.online>online.value))online={value:row.online,at:row.at};
   if(!messages||row.messages>messages.value)messages={value:row.messages,at:row.at};
   if(row.peakOnline!==null&&(!peakOnline||row.peakOnline>peakOnline.value||(row.peakOnline===peakOnline.value&&row.peakOnlineAt<peakOnline.at)))peakOnline={value:row.peakOnline,at:row.peakOnlineAt};
   if(row.peakChat!==null&&(!peakChat||row.peakChat>peakChat.value||(row.peakChat===peakChat.value&&row.peakChatAt<peakChat.at)))peakChat={value:row.peakChat,at:row.peakChatAt};
  }
  if(changed)this.cache.save(key,'channel-records',Array.from(this.rows.values()));
  return {online,messages,peakOnline,peakChat};
 }
}
