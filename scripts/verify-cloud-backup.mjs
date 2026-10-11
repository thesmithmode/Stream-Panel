import Database from 'better-sqlite3';
import {readFile,readdir,mkdtemp,rm,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {CloudBackup} from '../dist/apps/daemon/src/cloud-backup.js';
import {restoreBackupFile} from '../dist/apps/daemon/src/backup.js';
const dir=process.env.STREAM_PANEL_DATA_DIR,url=process.env.STREAM_PANEL_SUPABASE_URL,keyFile=process.env.STREAM_PANEL_BACKUP_KEY_FILE,serviceKeyFile=process.env.STREAM_PANEL_SUPABASE_KEY_FILE;
const hashFile=async path=>{const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');};
const inspect=path=>{
 const db=new Database(path,{readonly:true});db.pragma('busy_timeout=20000');
 try{
  if(db.pragma('integrity_check',{simple:true})!=='ok'||db.pragma('foreign_key_check').length)throw new Error('DATABASE_INTEGRITY_FAILED');
  const schemas=db.prepare('SELECT profile,version FROM sp_profile_schema ORDER BY profile').all();
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
  const counts={};for(const name of tables){if(!/^[a-z_][a-z0-9_]*$/.test(name))throw new Error('INVALID_TABLE_NAME');counts[name]=db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n;}
  return {integrity:'ok',schemas,tables:tables.length,counts};
 }finally{db.close();}
};
const summary=({integrity,schemas,tables})=>({integrity,schemas,tables});
if(!dir||!url||!keyFile||!serviceKeyFile){
 if(dir)console.log(JSON.stringify({live:summary(inspect(join(dir,'data.sqlite'))),cloud:{state:'not_configured'}}));
 throw new Error('CLOUD_BACKUP_NOT_CONFIGURED');
}
const staging=await mkdtemp(join(dir,'cloud-verify-'));
try{
 const ledger=JSON.parse(await readFile(join(dir,'backup-state.json'),'utf8'));
 const cloud=new CloudBackup({url,serviceKeyFile,prefix:'stream-panel/'+ledger.installationId});let filename,verified=false;
 for(let attempt=0;attempt<18;attempt++){
  const files=(await readdir(join(dir,'backups'))).filter(x=>/^stream-panel-[\dTZ-]+-[a-f0-9]{8}\.spbk$/.test(x)).sort().reverse();filename=files[0];
  if(!filename)throw new Error('LOCAL_BACKUP_MISSING');
  const local=join(dir,'backups',filename),remote=join(staging,'remote.spbk');
  try{
   const age=Date.now()-(await stat(local)).mtimeMs;if(age<0||age>13*3600000)throw new Error('CLOUD_BACKUP_STALE');
   await cloud.downloadFile(filename,remote);
   if(await hashFile(local)!==await hashFile(remote))throw new Error('CLOUD_BACKUP_HASH_MISMATCH');
   await restoreBackupFile(remote,Buffer.from((await readFile(keyFile,'utf8')).trim(),'hex'),join(staging,'restored'));
   const backup=inspect(join(staging,'restored','data.sqlite')),live=inspect(join(dir,'data.sqlite'));
   if(JSON.stringify(backup.schemas)!==JSON.stringify(live.schemas)||backup.tables!==live.tables)throw new Error('CLOUD_SCHEMA_MISMATCH');
   console.log(JSON.stringify({cloud:{project:new URL(url).hostname.split('.')[0],filename,ageMinutes:Math.round(age/6000)/10,hashVerified:true,restoreVerified:true},live:summary(live),backup:summary(backup)}));verified=true;break;
  }catch(error){await rm(remote,{force:true});await rm(join(staging,'restored'),{recursive:true,force:true});if(attempt===17)throw error;await new Promise(r=>setTimeout(r,10000));}
 }
 if(!verified)throw new Error('CLOUD_BACKUP_NOT_VERIFIED');
}finally{await rm(staging,{recursive:true,force:true});}
