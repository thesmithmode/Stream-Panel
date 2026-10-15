import {CURRENT_SCHEMA_VERSION} from "../../../packages/core/src/schema.js";
import Database from 'better-sqlite3';
import {stat,statfs} from 'node:fs/promises';
import {StreamStore} from '../../../packages/core/src/store.js';

/** Startup-only cleanup, before collectors and account connections open the database. */
export async function prepareChatStorage(path:string) {
 let size:number;
 try{size=(await stat(path)).size;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 const db=new Database(path,{fileMustExist:true});
 let versions:{profile:string;version:number}[]=[];
 let standalone=false,pending=false;
 try{
  db.pragma('busy_timeout=5000');
  size=Number(db.pragma('page_size',{simple:true}))*Number(db.pragma('page_count',{simple:true}));
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sp_profile_schema' AND type='table'").get())
   versions=db.prepare('SELECT profile,version FROM sp_profile_schema').all() as typeof versions;
  standalone=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='events' AND type='table'").get() && Number(db.pragma('user_version',{simple:true}))<CURRENT_SCHEMA_VERSION;
  const oldProfiles=versions.filter(row=>row.version>0&&row.version<CURRENT_SCHEMA_VERSION);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sp_pending_maintenance' AND type='table'").get())
   pending=!!db.prepare("SELECT 1 FROM sp_pending_maintenance WHERE name IN ('chat-content-v15','raw-storage-v16','storage-v17','storage-v18')").get();
  if(!standalone&&!oldProfiles.length&&!pending)return;
  // Persist before migration: a crash between content removal and VACUUM must retry compaction.
  db.exec('CREATE TABLE IF NOT EXISTS sp_pending_maintenance(name TEXT PRIMARY KEY) STRICT');
  db.prepare("INSERT OR IGNORE INTO sp_pending_maintenance VALUES ('storage-v18')").run();
  if(standalone){const store=new StreamStore(path);store.close();}
  for(const row of oldProfiles){const store=new StreamStore(path,row.profile);store.close();}
  const disk=await statfs(path),free=disk.bavail*disk.bsize;
  if(free<size*2+16*1024*1024)return {beforeBytes:size,afterBytes:(await stat(path)).size,compacted:false};
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw new Error('CHAT_CLEANUP_INTEGRITY_FAILED');
  db.prepare("DELETE FROM sp_pending_maintenance WHERE name IN ('chat-content-v15','raw-storage-v16','storage-v17','storage-v18')").run();
  db.pragma('wal_checkpoint(TRUNCATE)');
  return {beforeBytes:size,afterBytes:(await stat(path)).size,compacted:true};
 }finally{db.close();}
}
