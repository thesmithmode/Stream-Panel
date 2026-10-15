// Synthetic, isolated backup/restore measurement. Never opens a live database.
import Database from 'better-sqlite3';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
const implementation=process.argv[2]??'dist/apps/daemon/src/backup.js';
const {BackupService,restoreBackupFile}=await import(pathToFileURL(resolve(implementation)).href);
const dir=await mkdtemp(join(tmpdir(),'sp-backup-benchmark-')),key=randomBytes(32);
try{
 const db=new Database(join(dir,'data.sqlite'));
 try{db.exec('CREATE TABLE sp_auth_sessions(id TEXT); CREATE TABLE retained_facts(payload BLOB); INSERT INTO retained_facts VALUES(randomblob(24*1024*1024))');}finally{db.close();}
 await writeFile(join(dir,'key'),key.toString('hex'));
 const rssBefore=process.memoryUsage().rss,start=performance.now();
 const service=new BackupService(dir,{keyFile:join(dir,'key')});
 let result;
 try{result=await service.run();}finally{await service.stop();}
 const backupMs=performance.now()-start,backupPeakRss=process.resourceUsage().maxRSS*1024;
 await restoreBackupFile(join(dir,'backups',result.filename),key,join(dir,'restored'));
 const restored=new Database(join(dir,'restored','data.sqlite'),{readonly:true});
 try{if(restored.pragma('integrity_check',{simple:true})!=='ok'||restored.prepare('SELECT length(payload) AS n FROM retained_facts').get().n!==24*1024*1024)throw Error('RESTORE_MISMATCH');}finally{restored.close();}
 console.log(JSON.stringify({fixtureMiB:24,backupMs:Math.round(backupMs),rssBefore,backupPeakRss,restoreVerified:true,caveat:'Synthetic isolated process; excludes collectors, frontend, Redis and network.'}));
}finally{await rm(dir,{recursive:true,force:true});}
