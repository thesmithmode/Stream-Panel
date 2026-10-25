import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {AnalyticsReportCache} from './analytics-report-cache.js';
type RecordValue={value:number;at:number};
export type ChannelRecordValues={online:RecordValue|null;messages:RecordValue|null};
type Row={id:string;signature:string;at:number;online:number|null;messages:number};
/** Compact derived facts. Reuse unchanged streams, including across process restarts. */
export class ChannelRecords {
 private scope='';
 private rows=new Map<string,Row>();
 private cache:AnalyticsReportCache<Row[]>;
 constructor(private db:Database.Database,private metric:(id:string,botJson:string)=>{viewerKnownMean?:unknown;messageCount?:unknown}|undefined){this.cache=new AnalyticsReportCache(db);}
 read(botJson:string):ChannelRecordValues{
  const key=createHash('sha256').update('channel-records-v1:'+botJson).digest('hex');
  if(this.scope!==key){this.rows=new Map((this.cache.get(key)??[]).map(row=>[row.id,row]));this.scope=key;}
  const global=(this.db.prepare('SELECT revision FROM analytics_global_revision WHERE id=1').get() as {revision:number}).revision;
  const streams=this.db.prepare(`SELECT s.id,s.started_at_ms at,s.ended_at_ms ended,r.revision,
   (SELECT json_group_array(member_id) FROM session_groups WHERE group_id=s.id) members
   FROM sessions s LEFT JOIN analytics_stream_revisions r ON r.session_id=s.id
   WHERE NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=s.id) ORDER BY s.started_at_ms,s.id`).all() as {id:string;at:number;ended:number|null;revision:number;members:string}[];
  const ids=new Set(streams.map(s=>s.id));let changed=false;
  for(const id of this.rows.keys())if(!ids.has(id)){this.rows.delete(id);changed=true;}
  let online:RecordValue|null=null,messages:RecordValue|null=null;
  for(const stream of streams){
   const signature=JSON.stringify([stream.at,stream.ended,stream.revision,global,stream.members,stream.ended===null?Math.floor(Date.now()/60000):0]);
   let row=this.rows.get(stream.id);
   if(row?.signature!==signature){
    const metrics=this.metric(stream.id,botJson);
    row={id:stream.id,signature,at:stream.at,online:typeof metrics?.viewerKnownMean==='number'?metrics.viewerKnownMean:null,messages:Number(metrics?.messageCount??0)};
    this.rows.set(stream.id,row);changed=true;
   }
   if(row.online!==null&&(!online||row.online>online.value))online={value:row.online,at:row.at};
   if(!messages||row.messages>messages.value)messages={value:row.messages,at:row.at};
  }
  if(changed)this.cache.save(key,'channel-records',Array.from(this.rows.values()));
  return {online,messages};
 }
}
