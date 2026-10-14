import Database from 'better-sqlite3';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareChatStorage} from '../dist/apps/daemon/src/chat-cleanup.js';

// Reads only statistics, never message text, credentials, names or donor data.
const [databasePath,mode]=process.argv.slice(2);
if(!databasePath||!['',undefined,'--measure-cleanup'].includes(mode))throw new Error('Usage: audit-database.mjs DATABASE [--measure-cleanup]');
const quote=name=>'"'+name.replaceAll('"','""')+'"';
async function audit(path){
 const db=new Database(path,{readonly:true,fileMustExist:true});
 try{
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  let pages=[];try{pages=db.prepare('SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name').all();}catch{/* Some SQLite builds omit dbstat. */}
  const sizes=new Map(pages.map(row=>[row.name,row.bytes]));
  const details=[],diagnostics=[];
  for(const {name}of tables){
   const fields=db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(row=>row.name);
   const payload=fields.includes('payload_json')?'coalesce(sum(length(cast(payload_json AS BLOB))),0)':'0';
   const row=db.prepare(`SELECT count(*) AS rows,${payload} AS payloadBytes FROM ${quote(name)}`).get();
   details.push({table:name,...row,allocatedBytes:sizes.get(name)??null});
   if(name==='provider_snapshots'||/^p_[a-z0-9_]+_provider_snapshots$/.test(name))diagnostics.push(...db.prepare(`SELECT source,CASE WHEN substr(key,1,5)='chat:' THEN 'chat batches' WHEN key='followers' THEN 'follower history' WHEN key='chatters' THEN 'duplicate chatter lists' WHEN key='donation_history_page' THEN 'donation history pages' WHEN substr(key,1,4)='api:' THEN 'API diagnostics' ELSE 'other snapshots' END AS category,count(*) AS rows,sum(length(cast(payload_json AS BLOB))) AS bytes FROM ${quote(name)} GROUP BY source,category`).all().map(row=>({table:name,...row})));
  }
  return {fileBytes:(await stat(path)).size,pageBytes:Number(db.pragma('page_size',{simple:true}))*Number(db.pragma('page_count',{simple:true})),freePageBytes:Number(db.pragma('page_size',{simple:true}))*Number(db.pragma('freelist_count',{simple:true})),tables:details,diagnostics};
 }finally{db.close();}
}
const before=await audit(databasePath);
if(!mode)console.log(JSON.stringify(before,null,2));
else{
 const dir=await mkdtemp(join(tmpdir(),'sp-audit-copy-')),copy=join(dir,'data.sqlite');
 try{
  const source=new Database(databasePath,{readonly:true,fileMustExist:true});
  try{await source.backup(copy);}finally{source.close();}
  const cleanup=await prepareChatStorage(copy);
  const compact=new Database(copy);try{compact.exec('VACUUM');compact.pragma('wal_checkpoint(TRUNCATE)');}finally{compact.close();}
  const after=await audit(copy);
  console.log(JSON.stringify({before,after,freedBytes:before.pageBytes-after.pageBytes,sourceUnchanged:true,cleanup:cleanup??null},null,2));
 }finally{await rm(dir,{recursive:true,force:true});}
}
