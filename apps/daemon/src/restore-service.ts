import Database from 'better-sqlite3';
import {existsSync,createWriteStream} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {BACKUP_STREAM_MAX_SIZE} from './backup-stream.js';
import {copyFile,mkdir,open,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {restoreBackupFile,validateSnapshot} from './backup.js';
import {Configuration} from './config.js';
import {AccountStore,profiles} from './auth.js';

const files=['data.sqlite',...profiles.map(profile=>`profiles/${profile}/secrets.json`)];
async function sync(path:string){const file=await open(path,'r');try{await file.sync();}finally{await file.close();}}
export async function receiveRestore(input:Readable,output:string,maxSize=BACKUP_STREAM_MAX_SIZE){
 let size=0;
 const limit=new Transform({transform(chunk:Buffer,_encoding,done){size+=chunk.length;done(size>maxSize?new Error('BACKUP_SIZE_LIMIT'):null,chunk);}});
 await pipeline(input,limit,createWriteStream(output,{flags:'wx',mode:0o600}));
}
export async function stageRestore(input:string,key:Buffer,destination:string){
 await restoreBackupFile(input,key,destination);
 const accounts=new AccountStore(join(destination,'data.sqlite'));
 try{if(!accounts.users().length)throw new Error('BACKUP_HAS_NO_USERS');}finally{accounts.close();}
 for(const profile of profiles){const config=new Configuration(join(destination,'profiles',profile));await config.load();await config.save();}
 await sync(join(destination,'data.sqlite'));await sync(destination);
}
export async function commitRestore(dir:string,stage:string){
 await writeFile(join(dir,'restoring'),'pending',{flag:'wx',mode:0o600});
 let moved=false;
 try{await rename(stage,join(dir,'restore-pending'));moved=true;await sync(dir);}
 catch(error){if(moved)await rm(join(dir,'restore-pending'),{recursive:true,force:true});await rm(join(dir,'restoring'),{force:true});throw error;}
}
/** Called only with the collector listening port reserved and all old clients stopped.
 * Immutable staging is retained until every file is installed. A crash retries
 * the complete set before SQLite opens, including both profiles' credentials. */
export async function activatePendingRestore(dir:string){
 const pending=join(dir,'restore-pending');
 if(!existsSync(pending)){await rm(join(dir,'restoring'),{force:true});return false;}
 if(!existsSync(join(pending,'committed'))){
  const db=new Database(join(pending,'data.sqlite'),{readonly:true});try{validateSnapshot(db);}finally{db.close();}
  for(const file of files){
   const target=join(dir,file),next=target+'.restore-next';await mkdir(dirname(target),{recursive:true,mode:0o700});
   await copyFile(join(pending,file),next);await sync(next);
   if(file==='data.sqlite'){await rm(target+'-wal',{force:true});await rm(target+'-shm',{force:true});}
   await rename(next,target);await sync(dirname(target));
  }
  await writeFile(join(pending,'committed'),'complete',{mode:0o600});await sync(join(pending,'committed'));await sync(pending);
 }
 await rm(pending,{recursive:true,force:true});await rm(join(dir,'restoring'),{force:true});await sync(dir);return true;
}
