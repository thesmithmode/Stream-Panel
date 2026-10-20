import type Database from 'better-sqlite3';
import {gzipSync,gunzipSync} from 'node:zlib';
import {statfsSync} from 'node:fs';
import {dirname} from 'node:path';
import type {AnalyticsWorkspace} from './analytics-workspace.js';

/** Bounded, revision-addressed projections. Eviction never touches factual tables. */
export class AnalyticsReportCache<T>{
 constructor(private db:Database.Database,private limit=64*1024*1024){}
 get(key:string):T|undefined{
  if(this.limit<=0)return;
  const row=this.db.prepare('SELECT payload FROM analytics_reports WHERE cache_key=?').get(key) as {payload:Buffer}|undefined;
  if(!row)return;
  try{return JSON.parse(gunzipSync(row.payload,{maxOutputLength:16*1024*1024}).toString()) as T;}
  catch{this.db.prepare('DELETE FROM analytics_reports WHERE cache_key=?').run(key);return;}
 }
 save<P>(key:string,scope:string,value:T,workspace?:AnalyticsWorkspace<P>,allowEviction=true):boolean{
  const json=JSON.stringify(value);
  if(Buffer.byteLength(json)>16*1024*1024)return false;
  const payload=gzipSync(json),bytes=payload.length+(workspace?.storageBytes()??0);
  if(bytes>this.limit)return false;
  if(this.db.name!==':memory:'){const fs=statfsSync(dirname(this.db.name));if(fs.bavail*fs.bsize<1024*1024*1024+bytes)return false;}
  try{return this.db.transaction(()=>{
   if(!allowEviction){
    const retained=this.db.prepare('SELECT count(*) n,coalesce(sum(bytes),0) bytes FROM analytics_reports WHERE scope_key<>? AND cache_key<>?').get(scope,key) as {n:number;bytes:number};
    if(retained.n>=32||retained.bytes+bytes>this.limit)return false;
   }
   this.db.prepare('DELETE FROM analytics_reports WHERE scope_key=? OR cache_key=?').run(scope,key);
   let retained=(this.db.prepare('SELECT coalesce(sum(bytes),0) n FROM analytics_reports').get() as {n:number}).n;
   let count=(this.db.prepare('SELECT count(*) n FROM analytics_reports').get() as {n:number}).n;
   while(retained+bytes>this.limit||count>=32){
    const row=this.db.prepare('SELECT cache_key,bytes FROM analytics_reports ORDER BY updated_at_ms,cache_key LIMIT 1').get() as {cache_key:string;bytes:number};
    this.db.prepare('DELETE FROM analytics_reports WHERE cache_key=?').run(row.cache_key);retained-=row.bytes;count--;
   }
   this.db.prepare('INSERT INTO analytics_reports VALUES(?,?,?,?,?)').run(key,scope,payload,bytes,Date.now());
   workspace?.save(key);
   return true;
  }).immediate();}catch(error){
   if(['SQLITE_FULL','SQLITE_BUSY','SQLITE_LOCKED','SQLITE_READONLY'].includes(String((error as {code?:unknown})?.code)))return false;
   throw error;
  }
 }
}
