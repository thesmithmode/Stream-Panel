import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {StreamStore} from '../../../packages/core/src/store.js';
import {CURRENT_SCHEMA_VERSION} from '../../../packages/core/src/schema.js';
import {AccountStore} from '../src/auth.js';
import {BackupService,restoreBackup,sealBackup} from '../src/backup.js';

for(const mode of ['global-version','profile-version','foreign-key'] as const){
 test(`server backup and restore reject ${mode} snapshots before publishing data`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sp-backup-schema-')),path=join(dir,'data.sqlite'),key=randomBytes(32);
  const auth=new AccountStore(path),store=new StreamStore(path,'ruslan'),raw=new Database(path);
  await writeFile(join(dir,'key'),key.toString('hex'));
  const backup=new BackupService(dir,{keyFile:join(dir,'key')});
  try {
   if(mode==='global-version')raw.pragma(`user_version=${CURRENT_SCHEMA_VERSION+1}`);
   else if(mode==='profile-version')raw.prepare('UPDATE sp_profile_schema SET version=? WHERE profile=?').run(CURRENT_SCHEMA_VERSION+1,'ruslan');
   else{
    raw.pragma('foreign_keys=OFF');
    raw.prepare("INSERT INTO p_ruslan_person_notes VALUES ('orphan','missing-person','note',1,1,0)").run();
   }
   const expected=mode==='foreign-key'?/BACKUP_INTEGRITY_FAILED/:/UNSUPPORTED_SCHEMA_VERSION/;
   await assert.rejects(backup.run(),expected);
   const files=await readdir(join(dir,'backups'));
   assert.equal(files.some(name=>name.endsWith('.spbk')||name.includes('snapshot.tmp')),false);
   assert.equal(backup.status.local.lastSuccessAt,0);
   // Construct an authenticated old/external envelope, bypassing the creator's
   // guard, to verify the independent restore boundary as well.
   const snapshot=join(dir,'external.sqlite');await raw.backup(snapshot);
   const meta=Buffer.from(JSON.stringify({version:1,profiles:{}})),length=Buffer.alloc(4);length.writeUInt32BE(meta.length);
   const blob=sealBackup(Buffer.concat([length,meta,await readFile(snapshot)]),key),destination=join(dir,'restored');
   await assert.rejects(restoreBackup(blob,key,destination),expected);
   assert.equal((await readdir(dir)).includes('restored'),false);
   assert.equal(await readFile(snapshot).then(bytes=>bytes.length>0),true,'the source snapshot is retained');
  }finally{await backup.stop();raw.close();store.close();auth.close();await rm(dir,{recursive:true,force:true});}
 });
}
