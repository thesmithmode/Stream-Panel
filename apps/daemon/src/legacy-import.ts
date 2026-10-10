import Database from 'better-sqlite3';
import {mkdir,readFile,writeFile,copyFile,rename,rm,access,chmod} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {StreamStore} from '../../../packages/core/src/store.js';
import {schemaV1,schemaV2,schemaV3,schemaV4,schemaV5,schemaV6,schemaV7,schemaV8,schemaV9,schemaV10,schemaV11} from '../../../packages/core/src/schema.js';
import {AccountStore} from './auth.js';
const tables=[...`${schemaV1}\n${schemaV2}\n${schemaV3}\n${schemaV4}\n${schemaV5}\n${schemaV6}\n${schemaV7}\n${schemaV8}\n${schemaV9}\n${schemaV10}\n${schemaV11}`.matchAll(/CREATE TABLE (\w+)/g)].map(m=>m[1]!);
async function exists(path:string){try{await access(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
export async function migrateLegacy(source:string,destination:string) {
 if(await exists(destination))throw new Error('DESTINATION_EXISTS');
 try{
  const lock=await readFile(join(source,'daemon.lock'),'utf8'),pid=Number(lock.trim().split(/\s+/)[0]);
  if(!Number.isInteger(pid)||pid<1)throw new Error('INVALID_LEGACY_LOCK');
  try{process.kill(pid,0);throw new Error('LEGACY_RUNNING');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
 }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 let config:string|undefined;
 try{config=await readFile(join(source,'secrets.json'),'utf8');if(JSON.parse(config).version!==1)throw new Error('LEGACY_CONFIG_INVALID');}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('LEGACY_CONFIG_INVALID');}
 await mkdir(dirname(resolve(destination)),{recursive:true,mode:0o700});
 const staging=destination+'.import-'+randomBytes(8).toString('hex');await mkdir(staging,{mode:0o700});
 try{
  await mkdir(join(staging,'legacy-backup'),{mode:0o700});
  const snapshot=join(staging,'legacy-backup/data.sqlite');
  const original=new Database(join(source,'data.sqlite'),{readonly:true});
  try{await original.backup(snapshot);}finally{original.close();}
  await chmod(snapshot,0o600);await copyFile(snapshot,join(staging,'data.sqlite'));await chmod(join(staging,'data.sqlite'),0o600);
  const upgraded=new StreamStore(join(staging,'data.sqlite'));upgraded.close();
  const profile=new StreamStore(join(staging,'data.sqlite'),'ruslan');profile.close();
  const db=new Database(join(staging,'data.sqlite')),counts:Record<string,number>={};
  try{
   db.pragma('foreign_keys=OFF');
   db.transaction(()=>{
    for(const table of tables){
     counts[table]=(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as {n:number}).n;
     db.exec(`INSERT INTO "p_ruslan_${table}" SELECT * FROM "${table}"`);
     const actual=(db.prepare(`SELECT count(*) AS n FROM "p_ruslan_${table}"`).get() as {n:number}).n;
     if(actual!==counts[table])throw new Error('IMPORT_COUNT_MISMATCH');
    }
    for(const table of [...tables].reverse())db.exec(`DROP TABLE "${table}"`);
    if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length)throw new Error('IMPORT_INTEGRITY_FAILED');
   }).immediate();
   db.pragma('wal_checkpoint(TRUNCATE)');
  }finally{db.close();}
  if(config!==undefined){
   await mkdir(join(staging,'profiles/ruslan'),{recursive:true,mode:0o700});
   await writeFile(join(staging,'profiles/ruslan/secrets.json'),config,{mode:0o600});
   await writeFile(join(staging,'legacy-backup/secrets.json'),config,{mode:0o600});
  }
  await writeFile(join(staging,'legacy-import.json'),JSON.stringify({version:1,profile:'ruslan',tables:counts}),{mode:0o600});
  // Publishing the whole new directory is atomic; never overwrite a user's target.
  if(await exists(destination))throw new Error('DESTINATION_EXISTS');
  await rename(staging,destination);return {tables:counts};
 }catch(e){await rm(staging,{recursive:true,force:true});throw e;}
}
export async function prepareLocal(dir:string,legacy:string,password?:string) {
 if(!await exists(join(dir,'data.sqlite'))){
  if(!password)throw new Error('LOCAL_PASSWORD_REQUIRED');
  if(password.length<14||password.length>256)throw new Error('INVALID_PASSWORD');
  if(await exists(join(legacy,'data.sqlite')))await migrateLegacy(legacy,dir);
  else await mkdir(dir,{recursive:true,mode:0o700});
 }
 const accounts=new AccountStore(join(dir,'data.sqlite'));
 try{if(!accounts.users().length){if(!password)throw new Error('LOCAL_PASSWORD_REQUIRED');await accounts.createUser('ruslan','ruslan','Руслан',password);}}
 finally{accounts.close();}
 const key=join(dir,'backup-key');
 if(!await exists(key))await writeFile(key,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
 if(!/^[a-f0-9]{64}$/.test((await readFile(key,'utf8')).trim()))throw new Error('INVALID_BACKUP_KEY');
 await writeFile(join(dir,'local-ready'),'1',{mode:0o600});
}
