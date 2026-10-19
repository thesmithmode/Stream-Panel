import type {InsightPerson} from './insights.js';
import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {statfsSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname} from 'node:path';
import {matchesActivityDay,type TimeAudienceSummary} from './time-audience.js';

/** File-backed scratch data, private to this connection and excluded from backups. */
export class DiskMap<T> {
 constructor(private db:Database.Database,readonly table:string){
  db.function('sp_analytics_lower',{deterministic:true},value=>String(value).toLowerCase());
  db.exec(`CREATE TEMP TABLE ${table}(id TEXT PRIMARY KEY,value TEXT NOT NULL,seen INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`);
 }
 get(id:string):T|undefined{const row=this.db.prepare(`SELECT value FROM ${this.table} WHERE id=?`).get(id) as {value:string}|undefined;return row?JSON.parse(row.value) as T:undefined;}
 set(id:string,value:T){this.db.prepare(`INSERT INTO ${this.table}(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(id,JSON.stringify(value));}
 get size(){return (this.db.prepare(`SELECT count(*) n FROM ${this.table}`).get() as {n:number}).n;}
 *values():Generator<T>{
  let after='';
  for(;;){
   const rows=this.db.prepare(`SELECT id,value FROM ${this.table} WHERE id>? ORDER BY id LIMIT 32`).all(after) as {id:string;value:string}[];
   if(!rows.length)return;
   for(const row of rows){after=row.id;yield JSON.parse(row.value) as T;}
  }
 }
 firstVisit(id:string){return this.db.prepare(`UPDATE ${this.table} SET seen=1 WHERE id=? AND seen=0`).run(id).changes===1;}
 page(offset=0,search='',sort='core',coreOnly=false,limit=100){
  const fields:Record<string,string>={sessions:'sessionCount',observedMinutes:'observedMinutes',estimatedChatMinutes:'estimatedChatMinutes',messages:'messages',attendanceRatio:'attendanceRatio'};
  const metric=fields[sort],baseOrder="json_extract(value,'$.core') DESC,json_extract(value,'$.observedMinutes') DESC,json_extract(value,'$.messages') DESC",order=metric?`json_extract(value,'$.${metric}') DESC,${baseOrder}`:baseOrder;
  const where="(?=0 OR json_extract(value,'$.core')=1) AND (?='' OR instr(sp_analytics_lower(json_extract(value,'$.name')),sp_analytics_lower(?))>0)";
  const total=(this.db.prepare(`SELECT count(*) n FROM ${this.table} WHERE ${where}`).get(Number(coreOnly),search,search) as {n:number}).n;
  const rows=this.db.prepare(`SELECT value FROM ${this.table} WHERE ${where} ORDER BY ${order},id LIMIT ? OFFSET ?`).all(Number(coreOnly),search,search,limit,offset) as {value:string}[];
  return {items:rows.map(row=>JSON.parse(row.value) as T),total,offset,limit};
 }
}

export class AnalyticsWorkspace<P> {
 readonly people:DiskMap<P>;
 readonly insightPeople:DiskMap<InsightPerson>;
 private prefix=`sp_analytics_${randomUUID().replaceAll('-','')}`;
 private category:string;
 private clock:string;
 private disposed=false;
 private clockCache=new Map<string,{pages:ReturnType<AnalyticsWorkspace<P>['clockPages']>;bytes:number}>();
 private clockBytes=0;
 constructor(private db:Database.Database){
  this.category=`${this.prefix}_categories`;this.clock=`${this.prefix}_clock`;
  this.insightPeople=new DiskMap<InsightPerson>(db,`${this.prefix}_insights`);
  this.people=db.transaction(()=>{const people=new DiskMap<P>(db,`${this.prefix}_people`);
  db.exec(`CREATE TEMP TABLE ${this.category}(category TEXT NOT NULL,person TEXT NOT NULL,PRIMARY KEY(category,person)) WITHOUT ROWID;
   CREATE TEMP TABLE ${this.clock}(day TEXT NOT NULL,session TEXT NOT NULL,person TEXT NOT NULL,lo INTEGER NOT NULL,hi INTEGER NOT NULL,PRIMARY KEY(day,session,person,lo)) WITHOUT ROWID`);return people;})();
 }
 categoryPerson(category:string,person:string){this.db.prepare(`INSERT OR IGNORE INTO ${this.category} VALUES(?,?)`).run(category,person);}
 categoryCounts(category:string){return this.db.prepare(`SELECT count(*) audience,coalesce(sum(json_extract(p.value,'$.core')),0) core FROM ${this.category} c JOIN ${this.people.table} p ON p.id=c.person WHERE c.category=?`).get(category) as {audience:number;core:number};}
 addClock(session:string,buckets:TimeAudienceSummary[]){
  // Store the exact contiguous clock-minute membership once, instead of copying
  // each person for every resolution and weekday grouping. Stream identity stays intact.
  const pending=new Map<string,{day:string;person:string;lo:number;hi:number}>();
  const insert=this.db.prepare(`INSERT INTO ${this.clock} VALUES(?,?,?,?,?)`);
  const flush=(r:{day:string;person:string;lo:number;hi:number})=>insert.run(r.day,session,r.person,r.lo,r.hi);
  this.db.transaction(()=>{
   for(const bucket of buckets){
    if(bucket.resolution!==1||['all','weekdays','weekends'].includes(bucket.day))continue;
    for(const {id}of bucket.people){
     const key=`${bucket.day}:${id}`,prior=pending.get(key);
     if(prior&&prior.hi===bucket.minute)prior.hi++;
     else{if(prior)flush(prior);pending.set(key,{day:bucket.day,person:id,lo:bucket.minute,hi:bucket.minute+1});}
    }
   }
   for(const row of pending.values())flush(row);
  })();
 }
 clockPage(day:string,minute:number,resolution:number,offset=0){
  const selected=['пн','вт','ср','чт','пт','сб','вс'].filter(d=>matchesActivityDay(day,d));
  const sql=`FROM ${this.clock} c JOIN ${this.people.table} p ON p.id=c.person WHERE c.day IN(SELECT value FROM json_each(?)) AND c.lo<? AND c.hi>? GROUP BY c.person`;
  const args=[JSON.stringify(selected),minute+resolution,minute];
  const total=(this.db.prepare(`SELECT count(*) n FROM(SELECT c.person ${sql})`).get(...args) as {n:number}).n;
  const rows=this.db.prepare(`SELECT c.person id,json_extract(p.value,'$.name') name,json_extract(p.value,'$.sources') sources,count(DISTINCT c.session) visits ${sql} ORDER BY visits DESC,name,c.person LIMIT 100 OFFSET ?`).all(...args,offset) as {id:string;name:string;sources:string;visits:number}[];
  return {items:rows.map(r=>({...r,sources:JSON.parse(r.sources) as string[]})),total,offset,limit:100};
 }
 /** Prepare up to 48 adjacent first pages in one pass over compressed membership. */
 clockPages(day:string,minute:number,resolution:number):{minute:number;page:ReturnType<AnalyticsWorkspace<P>['clockPage']>}[]{
  const start=Math.floor(minute/(48*resolution))*48*resolution,key=`${day}:${resolution}:${start}`,cached=this.clockCache.get(key);
  if(cached)return cached.pages;
  const minutes=Array.from({length:Math.min(48,(1440-start)/resolution)},(_,i)=>start+i*resolution);
  const selected=['пн','вт','ср','чт','пт','сб','вс'].filter(d=>matchesActivityDay(day,d));
  const rows=this.db.prepare(`WITH visits AS (
   SELECT slot.value minute,c.person,count(DISTINCT c.session) visits
   FROM json_each(?) slot JOIN ${this.clock} c ON c.lo<slot.value+? AND c.hi>slot.value
   WHERE c.day IN(SELECT value FROM json_each(?)) GROUP BY slot.value,c.person
  ), ranked AS (
   SELECT v.*,json_extract(p.value,'$.name') name,json_extract(p.value,'$.sources') sources,
    count(*) OVER(PARTITION BY minute) total,
    row_number() OVER(PARTITION BY minute ORDER BY visits DESC,json_extract(p.value,'$.name'),person) rank
   FROM visits v JOIN ${this.people.table} p ON p.id=v.person
  ) SELECT minute,person id,name,sources,visits,total FROM ranked WHERE rank<=100 ORDER BY minute,rank`).all(JSON.stringify(minutes),resolution,JSON.stringify(selected)) as {minute:number;id:string;name:string;sources:string;visits:number;total:number}[];
  const pages=minutes.map(minute=>({minute,page:{items:[] as {id:string;name:string;sources:string[];visits:number}[],total:0,offset:0,limit:100}})),byMinute=new Map(pages.map(p=>[p.minute,p.page]));
  for(const {minute,total,...row} of rows){const page=byMinute.get(minute)!;page.total=total;page.items.push({...row,sources:JSON.parse(row.sources) as string[]});}
  const bytes=Buffer.byteLength(JSON.stringify(pages));
  if(bytes<=1024*1024){
   while(this.clockCache.size>=16||this.clockBytes+bytes>1024*1024){const oldest=this.clockCache.keys().next().value!;this.clockBytes-=this.clockCache.get(oldest)!.bytes;this.clockCache.delete(oldest);}
   this.clockCache.set(key,{pages,bytes});this.clockBytes+=bytes;
  }
  return pages;
 }
 checkBudget(){
  const pages=Number(this.db.pragma('temp.page_count',{simple:true}))-Number(this.db.pragma('temp.freelist_count',{simple:true}));
  if(pages*Number(this.db.pragma('temp.page_size',{simple:true}))>512*1024*1024)throw new Error('ANALYTICS_WORKSPACE_LIMIT');
  if(this.db.name!==':memory:')for(const path of new Set([dirname(this.db.name),process.env.SQLITE_TMPDIR??tmpdir(),'/var/tmp'])){if(!existsSync(path))continue;const fs=statfsSync(path);if(fs.bavail*fs.bsize<1021024*1024)throw new Error('ANALYTICS_DISK_RESERVE');}
 }
 dispose(){if(!this.disposed){this.clockCache.clear();this.clockBytes=0;this.db.exec(`DROP TABLE ${this.insightPeople.table};DROP TABLE ${this.people.table};DROP TABLE ${this.category};DROP TABLE ${this.clock}`);this.disposed=true;}}
}
