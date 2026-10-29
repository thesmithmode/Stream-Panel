import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {statfsSync} from 'node:fs';
import {dirname} from 'node:path';
import {historyTreeSchema} from './history-tree-schema.js';
import {mergeHistory,type HistoryFold} from './history-fold.js';
import type {TimeAudienceSummary} from './time-audience.js';
export interface FoldLeaf {id:string;position:string;version:string}
interface Branch {key:string;leaf?:FoldLeaf;children?:Branch[]}
const hash=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
/** A chronological radix tree. Appending/changing one broadcast replaces only its
 * leaf and ancestors. Unchanged subtrees are read as already-reduced statistics. */
export class HistoryTree {
 private statements=new Map<string,Database.Statement>();
 private writes=0;
 private statement(sql:string){let s=this.statements.get(sql);if(!s){s=this.db.prepare(sql);this.statements.set(sql,s);}return s;}
 constructor(private db:Database.Database,private policy:{availableBytes?:()=>number;maxTotalBytes?:number}={}){db.exec(historyTreeSchema);}
 allowed(){return (this.policy.maxTotalBytes??Infinity)>0&&(this.policy.availableBytes?.()??Infinity)>=1024*1024*1024;}
 private descriptor(leaves:FoldLeaf[],depth=0):Branch {
  if(leaves.length===1)return {key:hash(['history-leaf-4',leaves[0]!.version]),leaf:leaves[0]!};
  while(leaves[0]!.position[depth]===leaves.at(-1)!.position[depth])depth++;
  const groups:FoldLeaf[][]=[];for(const leaf of leaves){const last=groups.at(-1);if(last&&last[0]!.position[depth]===leaf.position[depth])last.push(leaf);else groups.push([leaf]);}
  const children=groups.map(group=>this.descriptor(group,depth+1));return {key:hash(['history-branch-1',children.map(c=>c.key)]),children};
 }
 root(leaves:FoldLeaf[],scope:string){
  const root=this.descriptor(leaves);
  const insert=this.statement('INSERT OR IGNORE INTO analytics_fold_edges VALUES(?,?)');
  this.db.transaction(()=>{
   const visit=(node:Branch)=>{for(const child of node.children??[]){insert.run(node.key,child.key);visit(child);}};visit(root);
   this.statement('INSERT INTO analytics_fold_roots VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET root=excluded.root,touched_at_ms=excluded.touched_at_ms').run(scope,root.key,Date.now());
  })();return root;
 }
 private read(key:string):HistoryFold|undefined {
  const row=this.statement('SELECT payload FROM analytics_fold_nodes WHERE key=?').get(key) as {payload:Buffer}|undefined;if(!row)return;
  try{const value=JSON.parse(gunzipSync(row.payload,{maxOutputLength:64*1024*1024}).toString()) as HistoryFold;if(!value.sample?.filters||!Array.isArray(value.people))throw Error('INVALID_FOLD');return value;}
  catch{this.statement('DELETE FROM analytics_fold_nodes WHERE key=?').run(key);return;}
 }
 private save(key:string,value:HistoryFold){
  const json=JSON.stringify(value);if(Buffer.byteLength(json)>64*1024*1024)throw Error('ANALYTICS_WORKSPACE_LIMIT');
  if(this.db.name!==':memory:'){const fs=statfsSync(dirname(this.db.name));if(fs.bavail*fs.bsize<1024*1024*1024+Buffer.byteLength(json))throw Error('ANALYTICS_DISK_RESERVE');}
  const payload=gzipSync(json);this.statement('INSERT INTO analytics_fold_nodes VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,bytes=excluded.bytes').run(key,payload,payload.length);this.writes++;
 }
 *reduce(root:Branch,timezone:string,build:(leaf:FoldLeaf,key:string)=>HistoryFold):Generator<void,HistoryFold,void>{
  let slice=performance.now();
  const walk=function*(this:HistoryTree,node:Branch):Generator<void,HistoryFold,void>{
   const saved=this.read(node.key);if(saved)return saved;
   let value:HistoryFold;
   if(node.leaf)value=build(node.leaf,node.key);
   else{let merged:HistoryFold|undefined;for(const child of node.children!){const next=yield* walk.call(this,child);merged=merged?mergeHistory(merged,next,timezone):next;}value=merged!;}
   this.save(node.key,value);
   if(performance.now()-slice>200){yield;slice=performance.now();}return value;
  };
  return yield* walk.call(this,root);
 }
 /** Store leaf membership once, independently of report generations/resolutions. */
 clock(key:string,session:string,buckets:TimeAudienceSummary[]){
  const pending=new Map<string,{day:string;person:string;lo:number;hi:number}>(),insert=this.statement('INSERT INTO analytics_fold_clock VALUES(?,?,?,?,?,?)');
  this.db.transaction(()=>{
   this.statement('DELETE FROM analytics_fold_clock WHERE leaf=?').run(key);
   const flush=(r:{day:string;person:string;lo:number;hi:number})=>insert.run(key,r.day,session,r.person,r.lo,r.hi);
   for(const bucket of buckets){if(bucket.resolution!==1||['all','weekdays','weekends'].includes(bucket.day))continue;
    for(const {id} of bucket.people){const k=`${bucket.day}:${id}`,prior=pending.get(k);if(prior&&prior.hi===bucket.minute)prior.hi++;else{if(prior)flush(prior);pending.set(k,{day:bucket.day,person:id,lo:bucket.minute,hi:bucket.minute+1});}}
   }for(const r of pending.values())flush(r);
  })();
 }
 /** Mark/sweep only disposable reductions. Keep current scopes and published replies. */
 collect(protectedRoots:string[]=[]){
  if(this.writes<128)return;this.writes=0;
  this.db.transaction(()=>{
   this.statement('DELETE FROM analytics_fold_roots WHERE scope NOT IN(SELECT scope FROM analytics_fold_roots ORDER BY touched_at_ms DESC,scope LIMIT 32)').run();
   const reachable=`WITH RECURSIVE live(key) AS(SELECT root FROM analytics_fold_roots UNION SELECT root FROM analytics_report_fold_roots UNION SELECT value FROM json_each(?) UNION SELECT e.child FROM analytics_fold_edges e JOIN live l ON l.key=e.parent)`;
   this.statement(`${reachable} DELETE FROM analytics_fold_nodes WHERE key NOT IN(SELECT key FROM live)`).run(JSON.stringify(protectedRoots));
   this.statement(`${reachable} DELETE FROM analytics_fold_clock WHERE leaf NOT IN(SELECT key FROM live)`).run(JSON.stringify(protectedRoots));
   this.statement(`${reachable} DELETE FROM analytics_fold_edges WHERE parent NOT IN(SELECT key FROM live)`).run(JSON.stringify(protectedRoots));
  })();
 }
}
